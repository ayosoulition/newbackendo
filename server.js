const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
const server = http.createServer(app);

// ---------------- TABLES ----------------
let tables = {
  1: { id: 1, status: "empty" },
  2: { id: 2, status: "empty" },
  3: { id: 3, status: "empty" },
  4: { id: 4, status: "empty" },
  5: { id: 5, status: "empty" },
  6: { id: 6, status: "empty" },
  7: { id: 7, status: "empty" },
  8: { id: 8, status: "empty" },
  9: { id: 9, status: "empty" },
  10: { id: 10, status: "empty" },
  11: { id: 11, status: "empty" },
  12: { id: 12, status: "empty" },
};

// ---------------- CORS ----------------
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

app.use(express.json());

app.get("/tables", (req, res) => {
  res.json(tables);
});

// ---------------- SOCKET ----------------
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// ---------------- DATA ----------------
let orders = {};

// ---------------- CREATE ORDER ----------------
app.post("/orders", (req, res) => {
  const { tableNumber, order } = req.body;

  if (!tableNumber || !order) {
    return res.status(400).json({ error: "Invalid order" });
  }

  // Save order by table number
  orders[tableNumber] = {
    tableNumber,
    order,
  };

  // 🔥 Update table status
  if (tables[tableNumber]) {
    tables[tableNumber].status = "ordered";
  }

  // 🔥 Emit updates
  io.emit("new-order", orders);
  io.emit("tables-update", tables);

  return res.status(201).json({
    message: "Order created",
    order: orders[tableNumber],
  });
});

// ---------------- UPDATE TABLE ----------------

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

    case "cancel":
      tables[id].status = "empty";
      delete orders[id];
      break;

    case "served":
      tables[id].status = "notPayed";
      break;

    case "bill":
      tables[id].status = "bill";
      break;

    case "paid":
      tables[id].status = "empty";
      delete orders[id];
      break;

    default:
      return res.status(400).json({
        error: "Invalid action",
        received: action,
      });
  }

  // 🔥 1. WAITER DASHBOARD (ALL TABLES)
  io.emit("tables-update", tables);

  // 🔥 2. CUSTOMER (ONLY ONE TABLE)
  io.emit("table-update", {
    tableId: id,
    status: tables[id].status,
  });

  return res.json({
    success: true,
    table: tables[id],
  });
});
// ---------------- GET ORDERS ----------------
app.get("/orders", (req, res) => {
  res.json(orders);
});

// ---------------- START SERVER ----------------
server.listen(3005, () => {
  console.log("Server running on port 3005");
});
