// scripts/db/mongo.js
import mongoose from "mongoose";

let connected = false;
let connectingPromise = null;

/**
 * Ensure a MongoDB connection is established.
 * Uses MONGO_URI and MONGO_DB env vars.
 * Returns true if Mongo is usable, false otherwise.
 */
export async function connectMongo() {
    if (connected) return true;
    if (connectingPromise) return connectingPromise;

    const uri = process.env.MONGO_URI;
    const dbName = process.env.MONGO_DB || "whiteboard";

    if (!uri) {
        console.warn("[Mongo] MONGO_URI not set. MongoDB persistence disabled. - mongo.js:20");
        return false;
    }

    console.log("[Mongo] Connecting to - mongo.js:24", uri, "db:", dbName);

    connectingPromise = mongoose
        .connect(uri, {
            dbName,
            serverSelectionTimeoutMS: 5000,
        })
        .then(() => {
            console.log("[Mongo] Connected - mongo.js:32");
            connected = true;
            return true;
        })
        .catch((err) => {
            console.error("[Mongo] Connection failed: - mongo.js:37", err.message);
            connected = false;
            connectingPromise = null;
            return false;
        });

    return connectingPromise;
}
