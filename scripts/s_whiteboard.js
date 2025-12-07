// scripts/s_whiteboard.js
// This file is only for saving the whiteboard.

import fs from "fs";
import config from "./config/config.js";
import { getSafeFilePath } from "./utils.js";

import { connectMongo } from "./db/mongo.js";
import WhiteboardModel from "./models/Whiteboard.js";

const FILE_DATABASE_FOLDER = "savedBoards";

var savedBoards = {};
var savedUndos = {};
var saveDelay = {};

if (config.backend.enableFileDatabase) {
    // make sure that folder with saved boards exists
    fs.mkdirSync(FILE_DATABASE_FOLDER, {
        // this option also mutes an error if path exists
        recursive: true,
    });
}

/**
 * Get the file path for a whiteboard.
 * @param {string} wid Whiteboard id to get the path for
 * @returns {string} File path to the whiteboard
 * @throws {Error} if wid contains potentially unsafe directory characters
 */
function fileDatabasePath(wid) {
    return getSafeFilePath(FILE_DATABASE_FOLDER, wid + ".json");
}

/**
 * Helper: load events from MongoDB (if configured)
 */
async function loadFromMongo(wid) {
    const ok = await connectMongo();
    if (!ok) return null;

    const doc = await WhiteboardModel.findOne({ wid }).lean().exec();
    if (!doc || !Array.isArray(doc.events)) return null;
    return doc.events;
}

/**
 * Helper: save events to MongoDB (fire-and-forget)
 */
async function saveToMongo(wid, events) {
    const ok = await connectMongo();
    if (!ok) return;

    try {
        await WhiteboardModel.updateOne(
            { wid },
            { wid, events },
            { upsert: true }
        ).exec();
    } catch (err) {
        console.error("[Mongo] Failed to save whiteboard - s_whiteboard.js:61", wid, err.message);
    }
}

const s_whiteboard = {
    /**
     * Handle incoming drawing / clear / undo / redo events
     * and update in-memory state + persistence.
     */
    handleEventsAndData: async function (content) {
        var tool = content["t"]; // Tool which is used
        var wid = content["wid"]; // whiteboard ID
        var username = content["username"];

        if (!wid) {
            return;
        }

        if (tool === "clear") {
            // Clear the whiteboard
            delete savedBoards[wid];
            delete savedUndos[wid];

            // delete the corresponding file too
            if (config.backend.enableFileDatabase) {
                try {
                    fs.unlink(fileDatabasePath(wid), function (err) {
                        if (err && err.code !== "ENOENT") {
                            console.log("[FS] Error deleting file: - s_whiteboard.js:89", err);
                        }
                    });
                } catch (e) {
                    console.log("[FS] unlink error: - s_whiteboard.js:93", e.message);
                }
            }

            // also clear in Mongo
            (async () => {
                const ok = await connectMongo();
                if (ok) {
                    await WhiteboardModel.deleteOne({ wid }).exec();
                }
            })();

            return;
        }

        if (tool === "undo") {
            // Undo an action
            if (!savedUndos[wid]) {
                savedUndos[wid] = [];
            }
            let savedBoard = await this.loadStoredData(wid);
            if (savedBoard && savedBoard.length) {
                for (let i = savedBoards[wid].length - 1; i >= 0; i--) {
                    if (savedBoards[wid][i]["username"] == username) {
                        const drawId = savedBoards[wid][i]["drawId"];
                        for (let j = savedBoards[wid].length - 1; j >= 0; j--) {
                            if (
                                savedBoards[wid][j]["drawId"] == drawId &&
                                savedBoards[wid][j]["username"] == username
                            ) {
                                savedUndos[wid].push(savedBoards[wid][j]);
                                savedBoards[wid].splice(j, 1);
                            }
                        }
                        break;
                    }
                }
                if (savedUndos[wid].length > 1000) {
                    savedUndos[wid].splice(0, savedUndos[wid].length - 1000);
                }
            }
        } else if (tool === "redo") {
            if (!savedUndos[wid]) {
                savedUndos[wid] = [];
            }
            let savedBoard = await this.loadStoredData(wid);
            if (savedBoard && savedUndos[wid].length) {
                for (let i = savedUndos[wid].length - 1; i >= 0; i--) {
                    if (savedUndos[wid][i]["username"] == username) {
                        const drawId = savedUndos[wid][i]["drawId"];
                        for (let j = savedUndos[wid].length - 1; j >= 0; j--) {
                            if (
                                savedUndos[wid][j]["drawId"] == drawId &&
                                savedUndos[wid][j]["username"] == username
                            ) {
                                savedBoard.push(savedUndos[wid][j]);
                                savedUndos[wid].splice(j, 1);
                            }
                        }
                        break;
                    }
                }
            }
        } else if (
            [
                "line",
                "pen",
                "rect",
                "circle",
                "eraser",
                "addImgBG",
                "recSelect",
                "eraseRec",
                "addTextBox",
                "setTextboxText",
                "removeTextbox",
                "setTextboxPosition",
                "setTextboxFontSize",
                "setTextboxFontColor",
            ].includes(tool)
        ) {
            let savedBoard = await this.loadStoredData(wid);
            // Save all these actions
            delete content["wid"]; // Delete id from content so we don't store it twice
            if (tool === "setTextboxText") {
                for (let i = savedBoard.length - 1; i >= 0; i--) {
                    // Remove old textbox text -> don't store it twice
                    if (
                        savedBoard[i]["t"] === "setTextboxText" &&
                        savedBoard[i]["d"][0] === content["d"][0]
                    ) {
                        savedBoard.splice(i, 1);
                    }
                }
            }
            savedBoard.push(content);
        }

        // Persist changes to file (optional) + Mongo
        this.saveToDB(wid);
        (async () => {
            const events = savedBoards[wid] || [];
            await saveToMongo(wid, events);
        })();
    },

    /**
     * Save to local file database (existing behaviour)
     */
    saveToDB: function (wid) {
        if (config.backend.enableFileDatabase) {
            // Save whiteboard to file
            if (!saveDelay[wid]) {
                saveDelay[wid] = true;
                setTimeout(function () {
                    saveDelay[wid] = false;
                    if (savedBoards[wid]) {
                        fs.writeFile(
                            fileDatabasePath(wid),
                            JSON.stringify(savedBoards[wid]),
                            (err) => {
                                if (err) {
                                    return console.log(err);
                                }
                            }
                        );
                    }
                }, 1000 * 10); // Save after 10 sec
            }
        }
    },

    /**
     * Load saved whiteboard (memory → Mongo → file)
     */
    loadStoredData: async function (wid) {
        if (wid in savedBoards) {
            return savedBoards[wid];
        }

        savedBoards[wid] = [];

        // 1) Try MongoDB first
        try {
            const fromMongo = await loadFromMongo(wid);
            if (fromMongo && Array.isArray(fromMongo) && fromMongo.length > 0) {
                savedBoards[wid] = fromMongo;
                return savedBoards[wid];
            }
        } catch (err) {
            console.error("[Mongo] Error loading board - s_whiteboard.js:243", wid, err.message);
        }

        // 2) Fallback: try to load from file DB
        if (config.backend.enableFileDatabase) {
            try {
                const filePath = fileDatabasePath(wid);
                if (fs.existsSync(filePath)) {
                    const data = fs.readFileSync(filePath);
                    if (data) {
                        savedBoards[wid] = JSON.parse(data);
                    }
                }
            } catch (e) {
                console.log("[FS] Error loading board - s_whiteboard.js:257", wid, e.message);
            }
        }

        return savedBoards[wid];
    },

    /**
     * Copy board contents from one wid to another
     */
    copyStoredData: async function (sourceWid, targetWid) {
        const sourceData = await this.loadStoredData(sourceWid);
        const targetData = await this.loadStoredData(targetWid);
        if (sourceData.length === 0 || targetData.length > 0) {
            return;
        }
        savedBoards[targetWid] = sourceData.slice();
        this.saveToDB(targetWid);
        (async () => {
            await saveToMongo(targetWid, savedBoards[targetWid]);
        })();
    },

    /**
     * Save full board data (used by import)
     */
    saveData: async function (wid, data) {
        const existingData = await this.loadStoredData(wid);
        if (existingData.length > 0 || !data) {
            return;
        }
        savedBoards[wid] = JSON.parse(data);
        this.saveToDB(wid);
        (async () => {
            await saveToMongo(wid, savedBoards[wid]);
        })();
    },
};

export { s_whiteboard as default };
