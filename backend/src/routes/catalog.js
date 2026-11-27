const { Router } = require("express");
const { Event } = require("../models/Event");
const catalog = require("../config/catalog");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { getIO } = require("../config/socket");
const { dispatchPending } = require("../queues/event-dispatch");

const router = Router();
router.use(requireAuth);

async function currentProduct(seed) {
  const latest = await Event.findOne({ topicId: seed.id, inventoryVersion: { $exists: true } })
    .sort({ inventoryVersion: -1 }).select("payload.product inventoryVersion").lean();
  return latest ? { ...latest.payload.product, version: latest.inventoryVersion } : { ...seed, version: 0 };
}

router.get("/", async (req, res) => {
  res.json(await Promise.all(catalog.map(currentProduct)));
});

router.patch("/:id", requireAdmin, async (req, res, next) => {
  const seed = catalog.find(item => item.id === req.params.id);
  if (!seed) return res.status(404).json({ error: "Product not found" });
  const { version, price, inStock } = req.body;
  const changingPrice = price !== undefined;
  if (!Number.isSafeInteger(version) || version < 0 || changingPrice === (inStock !== undefined) ||
      (changingPrice ? !Number.isSafeInteger(price) || price < 99 : typeof inStock !== "boolean")) {
    return res.status(400).json({ error: "Provide the current version and one valid price or stock change" });
  }
  const current = await currentProduct(seed);
  const conflict = () => res.status(409).json({ error: "Inventory changed. Refresh and try again." });
  if (current.version !== version) return conflict();
  if (changingPrice ? price === current.price : inStock === current.inStock) return res.json(current);
  const product = changingPrice ? { ...current, oldPrice: current.price, price } : { ...current, inStock };
  product.version += 1;
  const drop = changingPrice && price < current.price;
  try {
    await Event.create({
      topicId: seed.id, type: drop ? "price_drop" : "inventory_update",
      inventoryVersion: product.version, publishPending: drop,
      payload: { product, productId: seed.id, productName: seed.name, oldPrice: current.price, newPrice: product.price, currency: "USD" },
    });
  } catch (err) {
    if (err.code === 11000) return conflict();
    return next(err);
  }
  getIO().emit("catalog:update", product);
  if (drop) void dispatchPending();
  res.json(product);
});

module.exports = router;
