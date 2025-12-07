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
import Redis from "ioredis";       // ⭐ NEW

import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


// NEW — Redis PUB/SUB Initialization

const redisHost = process.env.REDIS_HOST || "redis";
const pub = new Redis({ host: redisHost });
const sub = new Redis({ host: redisHost });

sub.subscribe("whiteboard-channel");

export default function startBackendServer(port) {
    const window = new JSDOM("").window;
    const DOMPurify = createDOMPurify(window);

    var app = express();

    var server = http.Server(app);
    server.listen(port);
    var io = new Server(server, { path: "/ws-api" });
    WhiteboardInfoBackendService.start(io);

    console.log("socketserver running on port:" + port);

    const { accessToken, enableWebdav } = config.backend;

    //Expose static folders
    app.use(express.static(path.join(__dirname, "..", "dist")));
    app.use("/uploads", express.static(path.join(__dirname, "..", "public", "uploads")));

    // -----------------------------------------------------
    // ⭐ NEW — When Redis broadcasts an event → update local pod
    // -----------------------------------------------------
    sub.on("message", (channel, msg) => {
        const content = JSON.parse(msg);
        const wid = content["wid"];

        // Apply event to local memory + file DB
        s_whiteboard.handleEventsAndData(content);

        // Broadcast to clients connected to this pod
        io.to(wid).emit("drawToWhiteboard", content);
    });

    // -----------------------------------------------------
    // API ROUTES (unchanged)
    // -----------------------------------------------------

    app.get("/api/health", function (req, res) {
        res.status(200);
        res.end();
    });

    app.get("/api/loadwhiteboard", function (req, res) {
        let query = escapeAllContentStrings(req["query"]);
        const wid = query["wid"];
        const at = query["at"];
        if (accessToken === "" || accessToken == at) {
            const widForData = ReadOnlyBackendService.isReadOnly(wid)
                ? ReadOnlyBackendService.getIdFromReadOnlyId(wid)
                : wid;
            const ret = s_whiteboard.loadStoredData(widForData);
            res.send(ret);
            res.end();
        } else {
            res.status(401);
            res.end();
        }
    });

    app.get("/api/getReadOnlyWid", function (req, res) {
        let query = escapeAllContentStrings(req["query"]);
        const wid = query["wid"];
        const at = query["at"];
        if (accessToken === "" || accessToken == at) {
            res.send(ReadOnlyBackendService.getReadOnlyId(wid));
            res.end();
        } else {
            res.status(401);
            res.end();
        }
    });

    // -----------------------------------------------------
    // File Upload API (unchanged)
    // -----------------------------------------------------
    app.post("/api/upload", function (req, res) {
        var form = formidable({});
        var formData = { files: {}, fields: {} };

        form.on("file", function (name, file) {
            formData["files"][file.name] = file;
        });

        form.on("field", function (name, value) {
            formData["fields"][name] = value;
        });

        form.on("end", function () {
            const at = formData["fields"]["at"];
            if (accessToken === "" || accessToken == at) {
                progressUploadFormData(formData, function (err) {
                    if (err) {
                        res.status(err === "403" ? 403 : 500);
                        res.end();
                    } else {
                        res.send("done");
                    }
                });
            } else {
                res.status(401);
                res.end();
            }
        });

        form.parse(req);
    });

    // -----------------------------------------------------
    // ⭐ DRAW TO WHITEBOARD — This is where Redis is used
    // -----------------------------------------------------
    app.get("/api/drawToWhiteboard", function (req, res) {
        let query = escapeAllContentStrings(req["query"]);
        const wid = query["wid"];
        const at = query["at"];

        if (!wid || ReadOnlyBackendService.isReadOnly(wid)) {
            res.status(401);
            res.end();
            return;
        }

        if (accessToken === "" || accessToken == at) {
            try {
                query.th = parseFloat(query.th);
            } catch {}

            try {
                query.d = JSON.parse(query.d);
            } catch {}

            // ⭐ Instead of direct local save & broadcast → publish to Redis
            pub.publish("whiteboard-channel", JSON.stringify(query));

            res.send("done");
        } else {
            res.status(401);
            res.end();
        }
    });

    // -----------------------------------------------------
    // SOCKET.IO EVENTS
    // -----------------------------------------------------

    io.on("connection", function (socket) {
        let whiteboardId = null;

        socket.on("disconnect", function () {
            WhiteboardInfoBackendService.leave(socket.id, whiteboardId);
            socket.compress(false).broadcast.to(whiteboardId).emit("refreshUserBadges", null);
        });

        // JOIN ROOM / WHITEBOARD
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

                socket.join(whiteboardId);
                const screenResolution = content["windowWidthHeight"];
                WhiteboardInfoBackendService.join(socket.id, whiteboardId, screenResolution);
            } else {
                socket.emit("wrongAccessToken", true);
            }
        });

        // UPDATE SCREEN RESOLUTION
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

        // ⭐ MAIN DRAW BROADCAST (Redis version)
        socket.on("drawToWhiteboard", function (content) {
            if (!whiteboardId || ReadOnlyBackendService.isReadOnly(whiteboardId)) return;

            content = escapeAllContentStrings(content);
            content = purifyEncodedStrings(content);

            const at = content["at"];
            if (accessToken === "" || accessToken == at) {
                content["wid"] = whiteboardId;

                // ⭐ PUBLISH TO REDIS — NOT LOCAL BROADCAST
                pub.publish("whiteboard-channel", JSON.stringify(content));
            } else {
                socket.emit("wrongAccessToken", true);
            }
        });
    });

    // -----------------------------------------------------
    // XSS Sanitizers (unchanged)
    // -----------------------------------------------------

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
            console.warn("setTextboxText payload was sanitized");
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
}
