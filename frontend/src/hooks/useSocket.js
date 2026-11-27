import { useCallback, useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import { BASE_URL, clearNotifications, fetchNotifications } from "../services/api";

export const useSocket = (userId) => {
  const [socket, setSocket] = useState(null);
  const [isConnected, setConnected] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [inboxStatus, setInboxStatus] = useState("loading");
  const [inboxError, setInboxError] = useState("");
  const refresh = useRef(null);

  useEffect(() => {
    let active = true;
    let sequence = 0;
    let received = [];
    const client = io(BASE_URL, { auth: { token: localStorage.getItem("token") } });
    setSocket(client);

    async function sync() {
      const request = ++sequence;
      received = [];
      try {
        const response = await fetchNotifications(userId);
        if (!active || request !== sequence) return;
        const rows = [...received, ...response.data.data];
        setNotifications([...new Map(rows.map(row => [row._id, row])).values()].slice(0, 50));
        setInboxStatus("ready");
        setInboxError("");
      } catch {
        if (active && request === sequence) {
          setInboxStatus("error");
          setInboxError("Your saved alerts could not be loaded.");
        }
      }
    }
    refresh.current = sync;
    void sync();
    client.on("connect", () => { setConnected(true); void sync(); });
    client.on("disconnect", reason => {
      setConnected(false);
      if (reason === "io server disconnect") client.connect();
    });
    client.on("connect_error", error => {
      setConnected(false);
      if (error.message === "Invalid or expired session") void sync();
    });
    client.on("notification", data => {
      const item = { ...data, ...data.notification };
      if (!item._id) return;
      received = [item, ...received].slice(0, 50);
      setNotifications(rows => [item, ...rows.filter(row => row._id !== item._id)].slice(0, 50));
    });
    client.on("inbox:reset", sync);
    return () => {
      active = false;
      refresh.current = null;
      client.removeAllListeners();
      client.disconnect();
    };
  }, [userId]);

  const reloadInbox = useCallback(() => refresh.current?.(), []);
  const clearInbox = async () => {
    try {
      await clearNotifications(userId);
      await reloadInbox();
    } catch {
      setInboxError("Your inbox could not be cleared. Please try again.");
    }
  };
  return { socket, isConnected, notifications, clearInbox, reloadInbox, inboxError, inboxStatus };
};
