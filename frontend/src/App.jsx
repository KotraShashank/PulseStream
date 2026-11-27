import { useState, useEffect } from "react";
import { useSocket } from "./hooks/useSocket";
import { Navbar } from "./components/Navbar";
import { AdminDashboard } from "./components/AdminDashboard";
import { UserPanel } from "./components/UserPanel";
import { fetchCurrentUser } from "./services/api";
import { useCatalog } from "./hooks/useCatalog";
import { AuthPanel } from "./components/AuthPanel";
import { Bell, Activity } from "lucide-react";

export default function App() {
  const [currentUser, setCurrentUser] = useState(null);
  const [status, setStatus] = useState("loading");
  const [attempt, setAttempt] = useState(0);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    let active = true;
    const signedOut = () => {
      setCurrentUser(null);
      setStatus("ready");
      setNotice("Your session expired. Sign in again.");
    };
    const storage = event => {
      if (event.key === "token" || event.key === null) {
        setCurrentUser(null);
        setStatus("loading");
        setAttempt(n => n + 1);
      }
    };
    window.addEventListener("pulsestream:session-expired", signedOut);
    window.addEventListener("storage", storage);
    if (localStorage.getItem("token")) {
      fetchCurrentUser().then(({ data }) => {
        if (active) { setCurrentUser(data.user); setStatus("ready"); }
      }).catch(err => {
        if (active) setStatus(err.response?.status === 401 ? "ready" : "error");
      });
    } else setStatus("ready");
    return () => {
      active = false;
      window.removeEventListener("storage", storage);
      window.removeEventListener("pulsestream:session-expired", signedOut);
    };
  }, [attempt]);

  if (!currentUser) return (
    <div className="min-h-screen">
      <Navbar />
      <main className="px-4 py-8 sm:py-16">
        {notice && <p role="status" className="text-center text-sm text-slate-600">{notice}</p>}
        {status === "ready" ? <AuthPanel setCurrentUser={user => { setNotice(""); setCurrentUser(user); }} /> :
          <div role="status" className="mx-auto max-w-md rounded-2xl bg-white p-8 text-center shadow-sm">
            {status === "loading" ? "Restoring your session…" : <>
              <p>PulseStream could not reach the server.</p>
              <button onClick={() => { setStatus("loading"); setAttempt(n => n + 1); }} className="mt-3 font-semibold text-violet-700">Try again</button>
            </>}
          </div>}
      </main>
    </div>
  );
  return <Workspace key={currentUser._id} currentUser={currentUser} setCurrentUser={setCurrentUser} />;
}

function Workspace({ currentUser, setCurrentUser }) {
  const userId = currentUser._id || currentUser.id;
  const { socket, isConnected, notifications, clearInbox, reloadInbox, inboxError, inboxStatus } = useSocket(userId);
  const catalog = useCatalog(socket);
  const [activeTab, setActiveTab] = useState("consumer");
  const isAdmin = Boolean(currentUser?.isAdmin);

  return (
    <div className="min-h-screen flex flex-col">
      <Navbar
        isConnected={isConnected}
        notifications={notifications}
        onClearNotifications={clearInbox}
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        currentUser={currentUser}
      />

      <main className="flex-grow max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-10">
        {catalog.error && <p role="alert" className="mb-4 text-center text-sm text-rose-700">{catalog.error} <button onClick={catalog.reload} className="underline">Retry</button></p>}
        {inboxError && <p role="alert" className="mb-4 text-center text-sm text-rose-700">{inboxError} <button onClick={reloadInbox} className="underline">Retry</button></p>}
        {activeTab === "admin" && isAdmin ? (
          <AdminDashboard catalog={catalog} socket={socket} />
        ) : (
          <div className="max-w-5xl mx-auto space-y-8 animate-fadeIn">
            <UserPanel
              currentUser={currentUser}
              setCurrentUser={setCurrentUser}
              catalog={catalog}
            />

            {currentUser && (
              <div className="bg-white rounded-2xl shadow-sm border border-slate-200/70 p-6">
                <div className="flex justify-between items-center border-b border-slate-100 pb-4 mb-6">
                  <div>
                    <h2 className="text-lg font-bold text-slate-800 flex items-center">
                      <span className="bg-violet-50 text-violet-600 p-1.5 rounded-lg mr-2.5">
                        <Bell className="h-4 w-4" />
                      </span>
                      Live Notification Inbox
                    </h2>
                    <p className="text-xs text-slate-500 mt-1 ml-9">
                      Real-time alerts broadcast to {currentUser.name} appear
                      here instantly.
                    </p>
                  </div>
                  <span
                    className={`text-[11px] font-semibold px-2.5 py-1 rounded-full border ${
                      isConnected
                        ? "bg-emerald-50 border-emerald-200 text-emerald-700"
                        : "bg-rose-50 border-rose-200 text-rose-700"
                    }`}
                  >
                    {isConnected ? "● Live" : "○ Offline"}
                  </span>
                </div>

                {notifications.length === 0 ? (
                  <div className="text-center py-14 text-slate-400 bg-slate-50/60 rounded-xl border border-dashed border-slate-200">
                    <Activity className="h-10 w-10 mx-auto mb-3 text-violet-300" />
                    <p className="font-semibold text-slate-600 text-sm">
                      {inboxStatus === "loading" ? "Loading your alerts…" : inboxStatus === "error" ? "Inbox unavailable" : "No alerts yet"}
                    </p>
                    <p className="text-xs mt-1 text-slate-400">
                      Enable in-app alerts for a product to see its price drops here.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {notifications.map((notif) => (
                      <div
                        key={notif._id}
                        className="bg-violet-50/60 border-l-4 border-violet-500 p-4 rounded-r-xl flex flex-wrap justify-between items-start gap-3"
                      >
                        <div>
                          <span className="text-[10px] font-bold text-violet-600 uppercase bg-violet-100 px-2 py-0.5 rounded">
                            Push Alert
                          </span>
                          <h3 className="font-bold text-slate-900 text-base mt-1.5">
                            {notif.message}
                          </h3>
                        </div>
                        <span className="text-[11px] font-medium text-slate-400 bg-white px-2 py-1 rounded-full border border-slate-200 shrink-0">
                          {new Date(notif.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
