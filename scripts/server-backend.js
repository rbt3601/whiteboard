// scripts/server-backend.js
import path from "path";

import config from "./config/config.js";
import ROBackendService from "./services/ReadOnlyBackendService.js";
const ReadOnlyBackendService = new ROBackendService();
import WBInfoBackendService from "./services/WhiteboardInfoBackendService.js";
const WhiteboardInfoBackendService = new WBInfoBackendService();

import { getSafeFilePath } from "./utils.js";

import fs from "fs-extra";
import express from "express";
import formidable from "formidable"; //form upload processing

import createDOMPurify from "dompurify"; //Prevent xss
import { JSDOM } from "jsdom";

import { createClient } from "webdav";
import s_whiteboard from "./s_whiteboard.js";

import http from "http";
import { Server } from "socket.io";
import Redis from "ioredis";

import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Redis PUB/SUB Initialization
const redisHost = process.env.REDIS_HOST || "redis";
const redisPort = parseInt(process.env.REDIS_PORT || "6379", 10);

const pub = new Redis({ host: redisHost, port: redisPort });
const sub = new Redis({ host: redisHost, port: redisPort });

sub.subscribe("whiteboard-channel");

pub.on("error", (err) => {
    console.error("[Redis PUB] Error: - server-backend.js:41", err.message);
});
sub.on("error", (err) => {
    console.error("[Redis SUB] Error: - server-backend.js:44", err.message);
});

export default function startBackendServer(port) {
    const window = new JSDOM("").window;
    const DOMPurify = createDOMPurify(window);

    var app = express();

    var server = http.Server(app);
    server.listen(port);
    var io = new Server(server, { path: "/ws-api" });
    WhiteboardInfoBackendService.start(io);

    console.log("socketserver running on port: - server-backend.js:58" + port);

    const { accessToken, enableWebdav } = config.backend;

    //Expose static folders
    app.use(express.static(path.join(__dirname, "..", "dist")));
    app.use("/uploads", express.static(path.join(__dirname, "..", "public", "uploads")));

    // When Redis broadcasts an event → update local pod
    sub.on("message", async (channel, msg) => {
        try {
            const content = JSON.parse(msg);
            const wid = content["wid"];

            // Apply event to local memory + file DB + Mongo
            await s_whiteboard.handleEventsAndData(content);

            // Broadcast to clients connected to this pod
            io.to(wid).emit("drawToWhiteboard", content);
        } catch (e) {
            console.error("[Redis SUB] Message handling error: - server-backend.js:78", e.message);
        }
    });

    /**
     * @api {get} /api/health Health Check
     */
    app.get("/api/health", function (req, res) {
        res.status(200);
        res.end();
    });

    /**
     * @api {get} /api/loadwhiteboard Get Whiteboard Data
     */
    app.get("/api/loadwhiteboard", async function (req, res) {
        let query = escapeAllContentStrings(req["query"]);
        const wid = query["wid"];
        const at = query["at"]; //accesstoken
        if (accessToken === "" || accessToken == at) {
            const widForData = ReadOnlyBackendService.isReadOnly(wid)
                ? ReadOnlyBackendService.getIdFromReadOnlyId(wid)
                : wid;
            const ret = await s_whiteboard.loadStoredData(widForData);
            res.send(ret);
            res.end();
        } else {
            res.status(401); //Unauthorized
            res.end();
        }
    });

    /**
     * @api {get} /api/getReadOnlyWid Get the readOnlyWhiteboardId
     */
    app.get("/api/getReadOnlyWid", function (req, res) {
        let query = escapeAllContentStrings(req["query"]);
        const wid = query["wid"];
        const at = query["at"]; //accesstoken
        if (accessToken === "" || accessToken == at) {
            res.send(ReadOnlyBackendService.getReadOnlyId(wid));
            res.end();
        } else {
            res.status(401); //Unauthorized
            res.end();
        }
    });

    /**
     * @api {post} /api/upload Upload Images
     */
    app.post("/api/upload", function (req, res) {
        //File upload
        var form = formidable({}); //Receive form
        var formData = {
            files: {},
            fields: {},
        };

        form.on("file", function (name, file) {
            formData["files"][file.name] = file;
        });

        form.on("field", function (name, value) {
            formData["fields"][name] = value;
        });

        form.on("error", function () {
            console.log("File upload Error! - server-backend.js:146");
        });

        form.on("end", function () {
            if (accessToken === "" || accessToken == formData["fields"]["at"]) {
                progressUploadFormData(formData, function (err) {
                    if (err) {
                        if (err == "403") {
                            res.status(403);
                        } else {
                            res.status(500);
                        }
                        res.end();
                    } else {
                        res.send("done");
                    }
                });
            } else {
                res.status(401); //Unauthorized
                res.end();
            }
        });
        form.parse(req);
    });

    /**
     * @api {get} /api/drawToWhiteboard Draw on the Whiteboard
     */
    app.get("/api/drawToWhiteboard", async function (req, res) {
        let query = escapeAllContentStrings(req["query"]);
        const wid = query["wid"];
        const at = query["at"]; //accesstoken
        if (!wid || ReadOnlyBackendService.isReadOnly(wid)) {
            res.status(401); //Unauthorized
            res.end();
            return;
        }

        if (accessToken === "" || accessToken == at) {
            try {
                query.th = parseFloat(query.th);
            } catch (e) {
                // ignore
            }

            try {
                query.d = JSON.parse(query.d);
            } catch (e) {
                // ignore
            }

            // publish to Redis, all pods (including this one) will process
            pub.publish("whiteboard-channel", JSON.stringify(query));

            res.send("done");
        } else {
            res.status(401); //Unauthorized
            res.end();
        }
    });

    function progressUploadFormData(formData, callback) {
        console.log("Progress new Form Data - server-backend.js:208");
        const fields = escapeAllContentStrings(formData.fields);
        const wid = fields["wid"];
        if (ReadOnlyBackendService.isReadOnly(wid)) return;

        const readOnlyWid = ReadOnlyBackendService.getReadOnlyId(wid);

        const date = fields["date"] || +new Date();
        const filename = `${readOnlyWid}_${date}.png`;
        let webdavaccess = fields["webdavaccess"] || false;
        try {
            webdavaccess = JSON.parse(webdavaccess);
        } catch (e) {
            webdavaccess = false;
        }

        const savingDir = getSafeFilePath("public/uploads", readOnlyWid);
        fs.ensureDir(savingDir, function (err) {
            if (err) {
                console.log("Could not create upload folder! - server-backend.js:227", err);
                return;
            }
            let imagedata = fields["imagedata"];
            if (imagedata && imagedata != "") {
                //Save from base64 data
                imagedata = imagedata
                    .replace(/^data:image\/png;base64,/, "")
                    .replace(/^data:image\/jpeg;base64,/, "");
                console.log(filename, "uploaded - server-backend.js:236");
                const savingPath = getSafeFilePath(savingDir, filename);
                fs.writeFile(savingPath, imagedata, "base64", function (err) {
                    if (err) {
                        console.log("error - server-backend.js:240", err);
                        callback(err);
                    } else {
                        if (webdavaccess) {
                            //Save image to webdav
                            if (enableWebdav) {
                                saveImageToWebdav(
                                    savingPath,
                                    filename,
                                    webdavaccess,
                                    function (err) {
                                        if (err) {
                                            console.log("error - server-backend.js:252", err);
                                            callback(err);
                                        } else {
                                            callback();
                                        }
                                    }
                                );
                            } else {
                                callback("Webdav is not enabled on the server!");
                            }
                        } else {
                            callback();
                        }
                    }
                });
            } else {
                callback("no imagedata!");
                console.log("No image Data found for this upload! - server-backend.js:269", filename);
            }
        });
    }

    function saveImageToWebdav(imagepath, filename, webdavaccess, callback) {
        if (webdavaccess) {
            const webdavserver = webdavaccess["webdavserver"] || "";
            const webdavpath = webdavaccess["webdavpath"] || "/";
            const webdavusername = webdavaccess["webdavusername"] || "";
            const webdavpassword = webdavaccess["webdavpassword"] || "";

            const client = createClient(webdavserver, {
                username: webdavusername,
                password: webdavpassword,
            });
            client
                .getDirectoryContents(webdavpath)
                .then(() => {
                    const cloudpath = webdavpath + "" + filename;
                    console.log("webdav saving to: - server-backend.js:289", cloudpath);
                    fs.createReadStream(imagepath).pipe(client.createWriteStream(cloudpath));
                    callback();
                })
                .catch(() => {
                    callback("403");
                    console.log("Could not connect to webdav! - server-backend.js:295");
                });
        } else {
            callback("Error: no access data!");
        }
    }

    io.on("connection", function (socket) {
        let whiteboardId = null;
        socket.on("disconnect", function () {
            WhiteboardInfoBackendService.leave(socket.id, whiteboardId);
            socket.compress(false).broadcast.to(whiteboardId).emit("refreshUserBadges", null); //Removes old user Badges
        });

        socket.on("drawToWhiteboard", async function (content) {
            if (!whiteboardId || ReadOnlyBackendService.isReadOnly(whiteboardId)) return;

            content = escapeAllContentStrings(content);
            content = purifyEncodedStrings(content);

            if (accessToken === "" || accessToken == content["at"]) {
                content["wid"] = whiteboardId;

                // publish to Redis; all pods (including this one) will process
                pub.publish("whiteboard-channel", JSON.stringify(content));
            } else {
                socket.emit("wrongAccessToken", true);
            }
        });

        socket.on("joinWhiteboard", function (content) {
            content = escapeAllContentStrings(content);
            if (accessToken === "" || accessToken == content["at"]) {
                whiteboardId = content["wid"];

                socket.emit("whiteboardConfig", {
                    common: config.frontend,
                    whiteboardSpecific: {
                        correspondingReadOnlyWid:
                            ReadOnlyBackendService.getReadOnlyId(whiteboardId),
                        isReadOnly: ReadOnlyBackendService.isReadOnly(whiteboardId),
                    },
                });

                socket.join(whiteboardId); //Joins room name=wid
                const screenResolution = content["windowWidthHeight"];
                WhiteboardInfoBackendService.join(socket.id, whiteboardId, screenResolution);
            } else {
                socket.emit("wrongAccessToken", true);
            }
        });

        socket.on("updateScreenResolution", function (content) {
            content = escapeAllContentStrings(content);
            if (accessToken === "" || accessToken == content["at"]) {
                const screenResolution = content["windowWidthHeight"];
                WhiteboardInfoBackendService.setScreenResolution(
                    socket.id,
                    whiteboardId,
                    screenResolution
                );
            }
        });
    });

    //Prevent cross site scripting (xss)
    function escapeAllContentStrings(content, cnt) {
        if (!cnt) cnt = 0;

        if (typeof content === "string") {
            return DOMPurify.sanitize(content);
        }
        for (var i in content) {
            if (typeof content[i] === "string") {
                content[i] = DOMPurify.sanitize(content[i]);
            }
            if (typeof content[i] === "object" && cnt < 10) {
                content[i] = escapeAllContentStrings(content[i], ++cnt);
            }
        }
        return content;
    }

    //Sanitize strings known to be encoded and decoded
    function purifyEncodedStrings(content) {
        if (content.hasOwnProperty("t") && content["t"] === "setTextboxText") {
            return purifyTextboxTextInContent(content);
        }
        return content;
    }

    function purifyTextboxTextInContent(content) {
        const raw = content["d"][1];
        const decoded = base64decode(raw);
        const purified = DOMPurify.sanitize(decoded, {
            ALLOWED_TAGS: ["div", "br"],
            ALLOWED_ATTR: [],
            ALLOW_DATA_ATTR: false,
        });

        if (purified !== decoded) {
            console.warn("setTextboxText payload needed be DOMpurified - server-backend.js:396");
        }

        content["d"][1] = base64encode(purified);
        return content;
    }

    function base64encode(s) {
        return Buffer.from(s, "utf8").toString("base64");
    }

    function base64decode(s) {
        return Buffer.from(s, "base64").toString("utf8");
    }

    process.on("unhandledRejection", (error) => {
        console.log("unhandledRejection - server-backend.js:412", error.message);
    });
}
