// scripts/server.js
import { getArgs } from "./utils.js";
import startBackendServer from "./server-backend.js";

const SERVER_MODES = {
    PRODUCTION: 1,
    DEVELOPMENT: 2,
};

const args = getArgs();

if (typeof args.mode === "undefined") {
    // default to production mode
    args.mode = "production";
}

if (args.mode !== "production" && args.mode !== "development") {
    throw new Error("--mode can only be 'development' or 'production'");
}

const server_mode = args.mode === "production" ? SERVER_MODES.PRODUCTION : SERVER_MODES.DEVELOPMENT;

if (server_mode === SERVER_MODES.DEVELOPMENT) {
    let startFrontendDevServer = (await import("./server-frontend-dev.js")).startFrontendDevServer;
    console.info("Starting server in development mode. - server.js:25");
    startFrontendDevServer(8080, function () {
        // frontend on 8080, backend on 3000
        startBackendServer(3000);
    });
} else {
    console.info("Starting server in production mode. - server.js:31");
    startBackendServer(process.env.PORT || 8080);
}
