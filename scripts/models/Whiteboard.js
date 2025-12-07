// scripts/models/Whiteboard.js
import mongoose from "mongoose";

const WhiteboardSchema = new mongoose.Schema(
    {
        wid: { type: String, required: true, unique: true, index: true },
        events: { type: Array, default: [] }, // same structure as savedBoards[wid]
    },
    { timestamps: true }
);

export default mongoose.model("Whiteboard", WhiteboardSchema);
