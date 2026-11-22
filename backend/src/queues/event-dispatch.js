const { Event } = require("../models/Event");
const { fanoutQueue } = require("./fanout.queue");

let active = false;
async function dispatchPending() {
  if (active) return;
  active = true;
  try {
    const events = await Event.find({ publishPending: true }).sort({ _id: 1 }).limit(100).lean();
    for (const event of events) {
      await fanoutQueue.add("process-event", {
        eventId: event._id, topicId: event.topicId, type: event.type, payload: event.payload,
      }, { jobId: `event-${event._id}` });
      await Event.updateOne({ _id: event._id }, { $unset: { publishPending: 1 } });
    }
  } catch (error) {
    console.error("Event dispatch will retry:", error.name);
  } finally {
    active = false;
  }
}

function startDispatcher() {
  void dispatchPending();
  setInterval(dispatchPending, 15000).unref();
}

module.exports = { dispatchPending, startDispatcher };
