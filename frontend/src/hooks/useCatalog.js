import { useCallback, useEffect, useState } from "react";
import { fetchCatalog } from "../services/api";

function mergeProducts(current, incoming) {
  const latest = new Map(current.map(item => [item.id, item]));
  for (const item of incoming) {
    if ((latest.get(item.id)?.version ?? -1) <= item.version) latest.set(item.id, item);
  }
  return [...latest.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function useCatalog(socket) {
  const [products, setProducts] = useState([]);
  const [error, setError] = useState("");
  const applyProduct = useCallback(item => setProducts(current => mergeProducts(current, [item])), []);
  const reload = useCallback(async () => {
    try {
      const { data } = await fetchCatalog();
      setProducts(current => mergeProducts(current, data));
      setError("");
    } catch {
      setError("Inventory could not be loaded.");
    }
  }, []);
  useEffect(() => {
    void reload();
    socket?.on("connect", reload);
    socket?.on("catalog:update", applyProduct);
    return () => {
      socket?.off("connect", reload);
      socket?.off("catalog:update", applyProduct);
    };
  }, [socket, reload, applyProduct]);
  return { products, error, reload, applyProduct };
}
