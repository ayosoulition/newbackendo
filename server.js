require("dotenv").config();
const express = require("express");
const path = require("path");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const mongoose = require("mongoose");

const MenuItem = require("./models/MenuItem");
const User = require("./models/User");
const Table = require("./models/Table");
const Order = require("./models/Order");
const OrderHistory = require("./models/OrderHistory");

const rawMenuData = require("./data");

const JWT_SECRET = process.env.JWT_SECRET;
const PORT = process.env.PORT || 3005;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");

const app = express();
const server = http.createServer(app);

// ================= CORS =================
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));
app.use(express.json());

// ================= SOCKET =================
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

io.on("connection", (socket) => {
  socket.on("server-join", ({ serverId }) => {
    if (serverId) socket.join(`server-${serverId}`);
  });
});

// ================= MENU HELPERS =================
const PAGE_SIZE = 2;
const CATEGORIES = ["boissons", "boulangerie", "petitDejeuner", "glaces"];

function paginate(items) {
  const pages = [];
  for (let i = 0; i < items.length; i += PAGE_SIZE) {
    pages.push(items.slice(i, i + PAGE_SIZE));
  }
  return pages;
}

async function buildMenuData() {
  const items = await MenuItem.find({}).lean();
  const result = {};
  CATEGORIES.forEach((cat) => {
    result[cat] = paginate(items.filter((i) => i.type === cat));
  });
  return result;
}

async function getMaxId() {
  const item = await MenuItem.findOne({}).sort({ id: -1 }).select("id").lean();
  return item ? item.id : 0;
}

// ================= STATE HELPERS =================
async function getTables() {
  const arr = await Table.find({}).lean();
  const result = {};
  arr.forEach((t) => {
    result[t.id] = { id: t.id, status: t.status, serverName: t.serverName, serverId: t.serverId };
  });
  return result;
}

async function getOrders() {
  const arr = await Order.find({}).lean();
  const result = {};
  arr.forEach((o) => {
    result[o.tableNumber] = { tableNumber: o.tableNumber, order: o.order, createdAt: o.createdAt };
  });
  return result;
}

async function archiveOrder(tableId, finalStatus) {
  const numId = Number(tableId);
  const [order, table] = await Promise.all([
    Order.findOne({ tableNumber: numId }).lean(),
    Table.findOne({ id: numId }).lean(),
  ]);
  if (!order) return;
  await OrderHistory.create({
    id: Date.now(),
    tableNumber: numId,
    order: order.order,
    status: finalStatus,
    serverName: table?.serverName || "Unknown",
    archivedAt: new Date(),
  });
}

async function clearTable(id) {
  const numId = Number(id);
  await Promise.all([
    Table.updateOne({ id: numId }, { status: "empty", serverName: null, serverId: null }),
    Order.deleteOne({ tableNumber: numId }),
  ]);
}

// ================= AUTH MIDDLEWARE =================
function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: "No token provided" });
  const token = authHeader.split(" ")[1];
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}

function authorize(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: "Access denied" });
    }
    next();
  };
}

// ================= IMAGE UPLOAD =================
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) => cb(null, Date.now() + "-" + file.originalname),
});
const upload = multer({ storage });

// ================= AUTH ROUTES =================
app.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username }).lean();
    if (!user) return res.status(401).json({ success: false, error: "Invalid credentials" });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ success: false, error: "Invalid credentials" });

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      JWT_SECRET,
      { expiresIn: "8h" },
    );
    res.json({ success: true, token, role: user.role, id: user.id });
  } catch {
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/me", authenticate, (req, res) => res.json(req.user));

// ================= IMAGE UPLOAD =================
app.post(
  "/upload",
  authenticate,
  authorize("admin"),
  upload.single("image"),
  (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    res.json({
      success: true,
      filename: req.file.filename,
      url: `${BASE_URL}/uploads/${req.file.filename}`,
    });
  },
);

// ================= MENU ROUTES =================
app.get("/menu", async (req, res) => {
  try {
    res.json(await buildMenuData());
  } catch {
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/menu/:category", async (req, res) => {
  try {
    const { category } = req.params;
    if (!CATEGORIES.includes(category)) return res.status(404).json({ error: "Category not found" });
    const items = await MenuItem.find({ type: category }).lean();
    res.json(paginate(items));
  } catch {
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/menu/:category", authenticate, authorize("admin"), async (req, res) => {
  try {
    const { category } = req.params;
    if (!CATEGORIES.includes(category)) return res.status(404).json({ error: "Category not found" });

    const item = {
      ...req.body,
      type: category,
      img: req.body.img ? `${BASE_URL}/uploads/${req.body.img}` : "",
      id: (await getMaxId()) + 1,
    };
    await MenuItem.create(item);
    const menuData = await buildMenuData();
    io.emit("menu-update", menuData);
    res.status(201).json({ success: true, item });
  } catch {
    res.status(500).json({ error: "Server error" });
  }
});

app.put("/menu/:category/:itemId", authenticate, authorize("admin"), async (req, res) => {
  try {
    const { category, itemId } = req.params;
    const { price, title, description, img } = req.body;
    if (!CATEGORIES.includes(category)) return res.status(404).json({ error: "Category not found" });

    const existing = await MenuItem.findOne({ id: Number(itemId), type: category });
    if (!existing) return res.status(404).json({ error: "Item not found" });

    const update = {};
    if (price !== undefined) update.price = price;
    if (title !== undefined) update.title = title;
    if (description !== undefined) update.description = description;
    if (img) update.img = `${BASE_URL}/uploads/${img}`;

    await MenuItem.updateOne({ id: Number(itemId) }, update);
    const menuData = await buildMenuData();
    io.emit("menu-update", menuData);
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "Server error" });
  }
});

app.delete("/menu/:category/:itemId", authenticate, authorize("admin"), async (req, res) => {
  try {
    const { category, itemId } = req.params;
    if (!CATEGORIES.includes(category)) return res.status(404).json({ error: "Category not found" });

    const result = await MenuItem.deleteOne({ id: Number(itemId), type: category });
    if (result.deletedCount === 0) return res.status(404).json({ error: "Item not found" });

    const menuData = await buildMenuData();
    io.emit("menu-update", menuData);
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "Server error" });
  }
});

// ================= TABLE & ORDER READ ROUTES =================
app.get("/tables", async (req, res) => {
  try { res.json(await getTables()); } catch { res.status(500).json({ error: "Server error" }); }
});

app.get("/orders", async (req, res) => {
  try { res.json(await getOrders()); } catch { res.status(500).json({ error: "Server error" }); }
});

app.get("/history", async (req, res) => {
  try {
    const data = await OrderHistory.find({}).sort({ archivedAt: -1 }).lean();
    res.json({ count: data.length, data });
  } catch { res.status(500).json({ error: "Server error" }); }
});

// ================= CREATE ORDER (public — customers) =================
app.post("/orders", async (req, res) => {
  try {
    const { tableNumber, order } = req.body;
    if (!tableNumber || !order) return res.status(400).json({ error: "Invalid order" });

    const numTable = Number(tableNumber);
    await Order.findOneAndUpdate(
      { tableNumber: numTable },
      { tableNumber: numTable, order, createdAt: new Date() },
      { upsert: true },
    );
    await Table.updateOne({ id: numTable }, { status: "ordered" });

    const [orders, tables] = await Promise.all([getOrders(), getTables()]);
    io.emit("new-order", orders);
    io.emit("tables-update", tables);

    res.status(201).json({ success: true, order: orders[numTable] });
  } catch {
    res.status(500).json({ error: "Server error" });
  }
});

// ================= BILL REQUEST (public — customers) =================
app.patch("/tables/:id/bill", async (req, res) => {
  try {
    const numId = Number(req.params.id);
    const table = await Table.findOne({ id: numId });
    if (!table) return res.status(404).json({ error: "Table not found" });
    if (table.status !== "notPayed")
      return res.status(400).json({ error: "Table is not in a billable state" });

    await Table.updateOne({ id: numId }, { status: "bill" });
    io.emit("tables-update", await getTables());
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "Server error" });
  }
});

// ================= TABLE STATUS TRANSITIONS (staff only) =================
app.patch("/tables/:id/status", authenticate, async (req, res) => {
  try {
    const numId = Number(req.params.id);
    const { action } = req.body;
    const { id: serverId, username: serverName, role: userRole } = req.user;

    const table = await Table.findOne({ id: numId });
    if (!table) return res.status(404).json({ error: "Table not found" });

    switch (action) {
      case "confirm":
        if (userRole !== "serveur")
          return res.status(403).json({ error: "Only servers can confirm tables" });
        if (table.status !== "ordered")
          return res.status(400).json({ error: "Table is not awaiting confirmation" });
        if (table.serverId && table.serverId !== serverId)
          return res.status(409).json({ error: "Table already claimed by another server" });
        await Table.updateOne({ id: numId }, { status: "confirmed", serverName, serverId });
        break;

      case "ready":
        if (userRole !== "caisse")
          return res.status(403).json({ error: "Only kitchen can mark orders as ready" });
        await Table.updateOne({ id: numId }, { status: "ready" });
        if (table.serverId) {
          io.to(`server-${table.serverId}`).emit("order-ready", { tableId: req.params.id });
        }
        io.emit("tables-update", await getTables());
        return res.json({ success: true });

      case "served":
        if (userRole !== "serveur")
          return res.status(403).json({ error: "Only servers can serve tables" });
        if (table.serverId !== serverId)
          return res.status(403).json({ error: "You can only serve your own tables" });
        await Table.updateOne({ id: numId }, { status: "notPayed" });
        break;

      case "paid":
        if (userRole !== "serveur")
          return res.status(403).json({ error: "Only servers can process payment" });
        if (table.serverId !== serverId)
          return res.status(403).json({ error: "You can only process payment for your own tables" });
        await archiveOrder(numId, "paid");
        await clearTable(numId);
        break;

      case "cancel":
        if (userRole !== "serveur")
          return res.status(403).json({ error: "Only servers can cancel tables" });
        if (table.serverId && table.serverId !== serverId)
          return res.status(403).json({ error: "You can only cancel your own tables" });
        await archiveOrder(numId, "cancelled");
        await clearTable(numId);
        break;

      default:
        return res.status(400).json({ error: "Invalid action" });
    }

    const tables = await getTables();
    io.emit("tables-update", tables);
    return res.json({ success: true, table: tables[numId] });
  } catch {
    res.status(500).json({ error: "Server error" });
  }
});

// ================= DATA MIGRATION =================
// Fixes documents where Mongoose [Mixed] schema cast the order object into a
// single-element array: [{boissons:[...]}] → {boissons:[...]}
async function migrateOrderFields() {
  let fixed = 0;

  const orders = await Order.find({}).lean();
  for (const doc of orders) {
    if (
      Array.isArray(doc.order) &&
      doc.order.length > 0 &&
      !Array.isArray(doc.order[0]) &&
      typeof doc.order[0] === "object"
    ) {
      await Order.collection.updateOne(
        { _id: doc._id },
        { $set: { order: doc.order[0] } },
      );
      fixed++;
    }
  }

  const histories = await OrderHistory.find({}).lean();
  for (const doc of histories) {
    if (
      Array.isArray(doc.order) &&
      doc.order.length > 0 &&
      !Array.isArray(doc.order[0]) &&
      typeof doc.order[0] === "object"
    ) {
      await OrderHistory.collection.updateOne(
        { _id: doc._id },
        { $set: { order: doc.order[0] } },
      );
      fixed++;
    }
  }

  if (fixed > 0) console.log(`✓ Migrated ${fixed} document(s) with legacy order format`);
}

// ================= DB SEED =================
async function seedDatabase() {
  const [userCount, tableCount, menuCount] = await Promise.all([
    User.countDocuments(),
    Table.countDocuments(),
    MenuItem.countDocuments(),
  ]);

  if (userCount === 0) {
    await User.insertMany([
      { id: 1, username: "admin",    password: bcrypt.hashSync("admin123",   10), role: "admin"   },
      { id: 2, username: "serveur1", password: bcrypt.hashSync("serveur123", 10), role: "serveur" },
      { id: 3, username: "serveur2", password: bcrypt.hashSync("serveur456", 10), role: "serveur" },
      { id: 4, username: "serveur3", password: bcrypt.hashSync("serveur789", 10), role: "serveur" },
      { id: 5, username: "caisse1",  password: bcrypt.hashSync("caisse123",  10), role: "caisse"  },
    ]);
    console.log("✓ Users seeded");
  }

  if (tableCount === 0) {
    await Table.insertMany(
      Array.from({ length: 12 }, (_, i) => ({
        id: i + 1, status: "empty", serverName: null, serverId: null,
      })),
    );
    console.log("✓ Tables seeded (12)");
  }

  if (menuCount === 0) {
    const BASE = `${BASE_URL}/uploads/`;
    let counter = 1;
    const items = [];
    Object.values(rawMenuData).forEach((pages) => {
      pages.flat().forEach((item) => {
        items.push({
          ...item,
          id: counter++,
          img: `${BASE}${item.img}`,
        });
      });
    });
    await MenuItem.insertMany(items);
    console.log(`✓ Menu seeded (${items.length} items)`);
  }
}

// ================= MENU LANGUAGE MIGRATION =================
async function migrateMenuLanguage() {
  const allItems = Object.values(rawMenuData).flatMap((pages) => pages.flat());
  let updated = 0;
  for (const item of allItems) {
    const res = await MenuItem.updateOne(
      { id: item.id },
      { $set: { title: item.title, description: item.description } },
    );
    if (res.modifiedCount > 0) updated++;
  }
  if (updated > 0) console.log(`✓ Menu translated to French (${updated} items updated)`);
}

// ================= START =================
mongoose
  .connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
    socketTimeoutMS: 45000,
  })
  .then(async () => {
    console.log("✓ MongoDB connected");
    await seedDatabase();
    await migrateOrderFields();
    await migrateMenuLanguage();
    server.listen(PORT, () => console.log(`✓ Server running on port ${PORT}`));
  })
  .catch((err) => {
    console.error("✗ MongoDB connection failed:", err.message);
    console.error("  → Check: correct URI in .env, and your IP is whitelisted in MongoDB Atlas");
    console.error("    (Atlas: Network Access → Add IP Address → Allow access from anywhere)");
    process.exit(1);
  });
