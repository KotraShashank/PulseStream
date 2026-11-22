const { Schema, model } = require("mongoose");

const EventSchema = new Schema(
  {
    topicId: { type: String, required: true },
    type: { type: String, required: true },
    inventoryVersion: Number,
    publishPending: Boolean,
    payload: { type: Schema.Types.Mixed, required: true },
  },
  { timestamps: true },
);

EventSchema.index({ topicId: 1, inventoryVersion: -1 }, {
  unique: true, partialFilterExpression: { inventoryVersion: { $exists: true } },
});
EventSchema.index({ publishPending: 1 }, { partialFilterExpression: { publishPending: true } });

const Event = model("Event", EventSchema);

module.exports = { Event };
