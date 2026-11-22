import axios from "axios";

// Grab the pure root URL from the environment.
const CONFIGURED_URL = import.meta.env.VITE_API_URL || "http://localhost:5000";

// Normalize the URL so /api is appended exactly once.
export const BASE_URL = CONFIGURED_URL.replace(/\/+$/, "").replace(/\/api$/, "");
const API_URL = `${BASE_URL}/api`;

export const api = axios.create({
  baseURL: API_URL,
  timeout: 45000,
});

// Attach JWT to every authenticated request.
api.interceptors.request.use((config) => {
  const token = localStorage.getItem("token");
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Handle unauthorized sessions.
api.interceptors.response.use(
  (res) => res,
  (err) => {
    const token = localStorage.getItem("token");
    if (err.response?.status === 401 && token && err.config?.headers?.Authorization === `Bearer ${token}`) {
      localStorage.removeItem("token");
      window.dispatchEvent(new Event("pulsestream:session-expired"));
    }
    return Promise.reject(err);
  },
);

export const fetchMetrics = () => api.get("/analytics");
export const fetchFailures = () => api.get("/analytics/failures");
export const retryDelivery = (id) => api.post(`/analytics/retry/${id}`);
export const resetMetrics = () => api.post("/analytics/reset");

export const triggerTestEvent = (payload) => api.post("/events", payload);

export const fetchUsers = () => api.get("/users");
export const fetchCatalog = () => api.get("/catalog");
export const changeProduct = (id, patch) => api.patch(`/catalog/${id}`, patch);
export const updateWatchlist = (userId, productId, channel, enabled) =>
  api.patch(`/users/${userId}/watchlist`, { productId, channel, enabled });
export const enableAllNotifications = async (userId, productIds) => {
  return api.post(`/users/${userId}/arm-all`, { productIds });
};

export const loginUser = (email, password) =>
  api.post("/auth/login", { email, password });
export const signupUser = (name, email, password) =>
  api.post("/auth/signup", { name, email, password });
export const fetchCurrentUser = () => api.get("/auth/me");

export const fetchNotifications = (userId) =>
  api.get(`/notifications/${userId}`);
export const clearNotifications = (userId) =>
  api.delete(`/notifications/clear/${userId}`);

export const forgotPassword = (email) =>
  api.post("/auth/forgot-password", { email });
export const resetPassword = (token, newPassword) =>
  api.post("/auth/reset-password", { token, newPassword });
