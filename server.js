const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

// ================= IMPORT MENU DATA =================
const menuData = require("./data");

const app = express();
const server = http.createServer(app);

// ================= CORS =================
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

app.use(express.json());

// ================= SOCKET =================
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// ================= TABLES =================
let tables = {};
for (let i = 1; i <= 12; i++) {
  tables[i] = { id: i, status: "empty" };
}

// ================= ORDERS =================
let orders = {};

// ================= HISTORY =================
let orderHistory = [];

// ================= MENU PAGINATION LOGIC =================
const PAGE_SIZE = 2;

// flatten 2D -> 1D
function flattenCategory(categoryData) {
  return categoryData.flat();
}

// 1D -> 2D pages of 2 items
function paginate(items) {
  const pages = [];

  for (let i = 0; i < items.length; i += PAGE_SIZE) {
    pages.push(items.slice(i, i + PAGE_SIZE));
  }

  return pages;
}

// get max ID for menu items
function getMaxId() {
  let maxId = 0;

  Object.values(menuData)
    .flat(2)
    .forEach((item) => {
      if (item.id > maxId) maxId = item.id;
    });

  return maxId;
}

// archive order
function archiveOrder(tableId, finalStatus) {
  if (!orders[tableId]) return;

  orderHistory.push({
    id: Date.now(),
    tableNumber: tableId,
    order: orders[tableId].order,
    status: finalStatus,
    archivedAt: new Date().toISOString(),
  });
}

// ================= MENU ROUTES =================

// GET FULL MENU
app.get("/menu", (req, res) => {
  res.json(menuData);
});

// GET CATEGORY
app.get("/menu/:category", (req, res) => {
  const category = req.params.category;

  if (!menuData[category]) {
    return res.status(404).json({ error: "Category not found" });
  }

  res.json(menuData[category]);
});

// ================= ADD MENU ITEM =================
app.post("/menu/:category", (req, res) => {
  const { category } = req.params;
  const newItem = req.body;

  if (!menuData[category]) {
    return res.status(404).json({ error: "Category not found" });
  }

  const item = {
    ...newItem,
    id: getMaxId() + 1,
  };

  const flat = flattenCategory(menuData[category]);
  flat.push(item);

  menuData[category] = paginate(flat);

  io.emit("menu-update", menuData);

  res.status(201).json({
    success: true,
    item,
  });
});

// ================= UPDATE MENU ITEM =================
app.put("/menu/:category/:itemId", (req, res) => {
  const { category, itemId } = req.params;
  const { price, title, description, img } = req.body;

  if (!menuData[category]) {
    return res.status(404).json({ error: "Category not found" });
  }

  let found = false;

  menuData[category] = menuData[category].map((page) =>
    page.map((item) => {
      if (item.id === Number(itemId)) {
        found = true;
        return {
          ...item,
          price: price ?? item.price,
          title: title ?? item.title,
          description: description ?? item.description,
          img: img ?? item.img,
        };
      }
      return item;
    }),
  );

  if (!found) {
    return res.status(404).json({ error: "Item not found" });
  }

  io.emit("menu-update", menuData);

  res.json({ success: true });
});

// ================= DELETE MENU ITEM (REORDER PAGES) =================
app.delete("/menu/:category/:itemId", (req, res) => {
  const { category, itemId } = req.params;

  if (!menuData[category]) {
    return res.status(404).json({ error: "Category not found" });
  }

  let flat = flattenCategory(menuData[category]);

  const before = flat.length;

  flat = flat.filter((item) => item.id !== Number(itemId));

  if (flat.length === before) {
    return res.status(404).json({ error: "Item not found" });
  }

  menuData[category] = paginate(flat);

  io.emit("menu-update", menuData);

  res.json({ success: true });
});

// ================= TABLES =================
app.get("/tables", (req, res) => {
  res.json(tables);
});

// ================= ORDERS =================
app.get("/orders", (req, res) => {
  res.json(orders);
});

// ================= HISTORY =================
app.get("/history", (req, res) => {
  res.json({
    count: orderHistory.length,
    data: orderHistory,
  });
});

// ================= CREATE ORDER =================
app.post("/orders", (req, res) => {
  const { tableNumber, order } = req.body;

  if (!tableNumber || !order) {
    return res.status(400).json({ error: "Invalid order" });
  }

  orders[tableNumber] = {
    tableNumber,
    order,
    createdAt: new Date().toISOString(),
  };

  tables[tableNumber].status = "ordered";

  io.emit("new-order", orders);
  io.emit("tables-update", tables);

  return res.status(201).json({
    success: true,
    order: orders[tableNumber],
  });
});

// ================= UPDATE TABLE STATUS =================
app.patch("/tables/:id/status", (req, res) => {
  const id = req.params.id;
  const { action } = req.body;

  if (!tables[id]) {
    return res.status(404).json({ error: "Table not found" });
  }

  switch (action) {
    case "confirm":
      tables[id].status = "confirmed";
      break;

    case "ready":
      tables[id].status = "ready";
      break;

    case "served":
      tables[id].status = "notPayed";
      break;

    case "bill":
      tables[id].status = "bill";
      break;

    case "paid":
      tables[id].status = "empty";
      archiveOrder(id, "paid");
      delete orders[id];
      break;

    case "cancel":
      tables[id].status = "empty";
      archiveOrder(id, "cancelled");
      delete orders[id];
      break;

    default:
      return res.status(400).json({ error: "Invalid action" });
  }

  io.emit("tables-update", tables);

  return res.json({
    success: true,
    table: tables[id],
  });
});

// ================= START SERVER =================
server.listen(3005, () => {
  console.log("Server running on port 3005");
});
