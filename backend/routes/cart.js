const express = require("express");
const router = express.Router();
const db = require("../db");
const axios = require("axios");
const path = require("path");
const requireUser = require("../middleware/requireUser");

const TABLES = { vegetables: "vegetables", flowers: "flowers" };
const MIN_ORDER_VALUE = 799;

router.get("/recommendations/all", async (req, res) => {
  try {
    const sql = `
      SELECT id, name, price, image, quantity AS unit, 'vegetables' AS category FROM vegetables 
      UNION 
      SELECT id, name, price, image, quantity AS unit, 'flowers' AS category FROM flowers`;
    const [results] = await db.query(sql);
    res.json({ success: true, products: results });
  } catch (err) {
    console.error("Recommendations error:", err.message);
    res.status(500).json({ success: false, products: [] });
  }
});

router.get("/last-address/:user_id", requireUser, async (req, res) => {
  try {
    const userId = req.userEmail;
    let address = null;

    try {
      const [rows] = await db.query(
        "SELECT * FROM addresses WHERE user_id = ? ORDER BY is_default DESC, id DESC LIMIT 1",
        [userId]
      );
      if (rows.length > 0) address = rows[0];
    } catch (e) {
      console.error("Address query error:", e.message);
    }

    if (!address) {
      try {
        const [orders] = await db.query(
          "SELECT * FROM cart_orders WHERE user_id = ? ORDER BY id DESC LIMIT 1",
          [userId]
        );
        if (orders.length > 0) {
          const o = orders[0];
          address = {
            full_name: o.name || "", phone: o.phone_number || "", alt_phone: o.alt_phone_num || "",
            building: o.building_name || "", street: o.street || "", landmark: o.landmark || "",
            city: o.city_or_village || "", postal_code: o.pin_code || ""
          };
        }
      } catch (e) { console.error("Cart orders fallback error:", e.message); }
    }

    res.json({ success: true, address });
  } catch (err) {
    res.status(500).json({ success: false, address: null });
  }
});

router.post("/add", requireUser, async (req, res) => {
  const { product_id, category } = req.body;
  const user_id = req.userEmail;

  if (!TABLES[category]) {
    return res.status(400).json({ success: false, message: "Invalid category" });
  }
  const tableName = TABLES[category];
  try {
    const [data] = await db.query(`SELECT name, price, image FROM ${tableName} WHERE id = ?`, [product_id]);
    if (data.length === 0) return res.status(404).json({ success: false, message: "Product not found" });
    
    const p = data[0];
    const sql = `INSERT INTO cart (user_id, product_id, name, price, image, category, quantity) 
                 VALUES (?, ?, ?, ?, ?, ?, 1) ON DUPLICATE KEY UPDATE quantity = quantity + 1`;
                 
    await db.query(sql, [user_id, product_id, p.name, p.price, p.image, category]);
    res.json({ success: true, message: "Item added to cart successfully" });
  } catch (err) {
    console.error("Add to cart error:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

router.put("/increase/:id", requireUser, async (req, res) => {
  try {
    const [result] = await db.query(
      "UPDATE cart SET quantity = quantity + 1 WHERE id = ? AND user_id = ?",
      [req.params.id, req.userEmail]
    );
    if (result.affectedRows === 0) return res.status(404).json({ success: false, message: "Cart item not found" });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.put("/decrease/:id", requireUser, async (req, res) => {
  try {
    const [result] = await db.query(
      "UPDATE cart SET quantity = GREATEST(1, quantity - 1) WHERE id = ? AND user_id = ?",
      [req.params.id, req.userEmail]
    );
    if (result.affectedRows === 0) return res.status(404).json({ success: false, message: "Cart item not found" });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.get("/:user_id", requireUser, async (req, res) => {
  try {
    const sql = `
      SELECT c.*, COALESCE(v.quantity, f.quantity) AS unit, COALESCE(v.stock, f.stock) AS stock
      FROM cart c
      LEFT JOIN vegetables v ON c.product_id = v.id AND c.category = 'vegetables'
      LEFT JOIN flowers f ON c.product_id = f.id AND c.category = 'flowers'
      WHERE c.user_id = ?
    `;
    const [data] = await db.query(sql, [req.userEmail]);
    res.json({ success: true, cart: data });
  } catch (err) {
    console.error("Get cart error:", err.message);
    res.status(500).json({ success: false, cart: [] });
  }
});

router.delete("/:id", requireUser, async (req, res) => {
  try {
    const [result] = await db.query(
      "DELETE FROM cart WHERE id = ? AND user_id = ?",
      [req.params.id, req.userEmail]
    );
    if (result.affectedRows === 0) return res.status(404).json({ success: false, message: "Cart item not found" });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Formats a "YYYY-MM-DD" delivery date into something readable, e.g. "Mon, 05 Aug 2026"
function formatDeliveryDate(dateStr) {
  if (!dateStr) return "-";
  const d = new Date(`${dateStr}T00:00:00`);
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString("en-IN", { weekday: "short", day: "2-digit", month: "short", year: "numeric" });
}

// Order-placed timestamp, formatted in IST regardless of server timezone
function formatOrderPlacedAt(date) {
  return date.toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }) + " IST";
}

async function sendCheckoutEmail(total_price, contact, dropAddress, items, deliveryDate, deliverySlot, orderPlacedAt) {
  try {
    const attachments = [];
    const htmlItems = await Promise.all(
      items.map(async (item) => {
        if (item.image && item.image.startsWith("http")) {
          try {
            const imgResponse = await axios.get(item.image, { responseType: "arraybuffer", timeout: 4000 });
            const ext = path.extname(new URL(item.image).pathname).replace(".", "") || "jpg";
            attachments.push({ name: `${item.name.replace(/\s+/g, "_")}.${ext}`, content: Buffer.from(imgResponse.data).toString("base64") });
          } catch (e) { console.warn(`Could not attach image for ${item.name}:`, e.message); }
        }
        return `
          <tr style="border-bottom: 1px solid #eee;">
            <td style="padding: 10px; font-size: 16px;"><b>${item.name}</b><br/><span style="color:#666;">Qty: ${item.quantity}</span></td>
            <td style="padding: 10px; font-weight: bold; font-size: 16px;">₹${item.price}</td>
          </tr>
        `;
      })
    ).then((rows) => rows.join(""));

    const htmlContent = `
      <div style="font-family: sans-serif; color: #222; max-width: 600px;">
        <h2 style="color: #0c831f;">New Grocery Order! 🛒</h2>
        <p style="color:#666; font-size:13px; margin: -10px 0 15px 0;">Order placed: ${orderPlacedAt}</p>
        <table width="100%" style="border-collapse: collapse; margin-bottom: 20px;">${htmlItems}</table>
        <h3 style="background: #f4f6f9; padding: 15px; border-radius: 8px;">Total Paid: ₹${total_price}</h3>

        <div style="background:#fff7ed; border:1px solid #f59e0b; border-radius:8px; padding:14px 16px; margin-bottom:20px;">
          <p style="margin:0; font-size:16px; font-weight:bold; color:#b45309;">
            ⏰ Needed By: ${formatDeliveryDate(deliveryDate)} &nbsp;|&nbsp; ${deliverySlot || "-"}
          </p>
        </div>

        <h4 style="border-bottom: 2px solid #eee; padding-bottom: 5px;">Delivery Details:</h4>
        <p><strong>Name:</strong> ${contact.fullName}</p>
        <p><strong>Phone:</strong> +91 ${contact.phone}</p>
        <p><strong>Alt Phone:</strong> +91 ${contact.altPhone || "-"}</p>
        <h4 style="border-bottom: 2px solid #eee; padding-bottom: 5px;">Full Delivery Address:</h4>
        <p>
          ${contact.building || ""}<br/>
          ${contact.street || ""}<br/>
          ${contact.landmark ? contact.landmark + "<br/>" : ""}
          ${contact.city || ""} - ${contact.postalCode || ""}
        </p>
        <p style="color:#666; font-size:13px;"><strong>Full address (single line):</strong> ${dropAddress}</p>
      </div>
    `;

    const brevoPayload = {
      sender: { name: "ShiperBox Cart Orders", email: process.env.EMAIL_USER },
      to: [{ email: "shiperbox@gmail.com", name: "Admin" }],
      subject: `New Grocery Cart Order - ₹${total_price} (Needed by ${formatDeliveryDate(deliveryDate)}, ${deliverySlot || "-"})`,
      htmlContent: htmlContent,
      attachment: attachments.length > 0 ? attachments : undefined
    };

    await axios.post("https://api.brevo.com/v3/smtp/email", brevoPayload, { headers: { "api-key": process.env.BREVO_API_KEY, "Content-Type": "application/json", Accept: "application/json" } });
  } catch (emailErr) { console.error("Cart email notification error:", emailErr.response?.data || emailErr.message); }
}

router.post("/checkout", requireUser, async (req, res) => {
  const { items, total_price, contact, saveAsDefault, isNewAddress } = req.body;
  const user_id = req.userEmail;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, message: "Your cart is empty." });
  }
  if (!contact || !contact.fullName || !contact.phone || !contact.building || !contact.street || !contact.city || !contact.postalCode) {
    return res.status(400).json({ success: false, message: "Missing delivery details." });
  }
  if (!contact.deliveryDate || !contact.deliverySlot) {
    return res.status(400).json({ success: false, message: "Please choose a delivery date and time slot." });
  }
  // Delivery date must be a valid, non-past date
  const deliveryDateObj = new Date(`${contact.deliveryDate}T00:00:00`);
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  if (isNaN(deliveryDateObj.getTime()) || deliveryDateObj < todayStart) {
    return res.status(400).json({ success: false, message: "Please choose a valid, upcoming delivery date." });
  }
  let safe_total_price = total_price;
  if (typeof safe_total_price !== "number" || !(safe_total_price > 0)) {
    return res.status(400).json({ success: false, message: "Invalid order total." });
  }
  
  safe_total_price = Math.round(safe_total_price); // Fix floating point issues
  
  if (safe_total_price < MIN_ORDER_VALUE) {
    return res.status(400).json({ success: false, message: `Minimum order value is ₹${MIN_ORDER_VALUE}. Please add more items to your cart.` });
  }

  let connection;
  try {
    connection = await db.getConnection();
    await connection.beginTransaction();

    const enrichedItems = [];
    for (const item of items) {
      const table = item.category === "flowers" ? "flowers" : "vegetables";
      const productId = item.product_id || item.id;
      const [stockRow] = await connection.query(
        `SELECT name, price, image, stock, quantity AS unit FROM ${table} WHERE id = ? FOR UPDATE`,
        [productId]
      );
      if (!stockRow.length || stockRow[0].stock < item.quantity) throw new Error(`Item "${item.name}" is out of stock or requested quantity is unavailable.`);
      await connection.query(`UPDATE ${table} SET stock = stock - ? WHERE id = ?`, [item.quantity, productId]);

      // Pull name/image/unit fresh from the product table so order history always
      // has accurate details (1kg/half kg, image) even if the product changes later.
      enrichedItems.push({
        product_id: productId,
        category: item.category,
        name: stockRow[0].name,
        image: stockRow[0].image,
        unit: stockRow[0].unit, // e.g. "1kg" or "500g"
        quantity: item.quantity,
        price: item.price,
      });
    }

    const dropAddress = `${contact.building}, ${contact.street}, ${contact.landmark ? contact.landmark + ", " : ""}${contact.city} - ${contact.postalCode}`;
    const orderPlacedAt = new Date();
    const orderData = { contact, items: enrichedItems, deliveryDate: contact.deliveryDate, deliverySlot: contact.deliverySlot };
    const jsonNotes = JSON.stringify(orderData);
    const itemsNames = enrichedItems.map((i) => `${i.name} (${i.unit || ""}) x${i.quantity}`).join(", ");

    // NOTE: requires `delivery_date` (DATE) and `delivery_slot` (VARCHAR) columns on cart_orders.
    // Migration if missing:
    //   ALTER TABLE cart_orders ADD COLUMN delivery_date DATE NULL, ADD COLUMN delivery_slot VARCHAR(50) NULL;
    const insertQuery = `
      INSERT INTO cart_orders 
      (user_id, items_names, items_price, total_price, name, phone_number, alt_phone_num, building_name, landmark, street, pin_code, city_or_village, drop_address, delivery_date, delivery_slot, notes, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NOW())
    `;

    const [result] = await connection.query(insertQuery, [
      user_id, itemsNames, total_price, total_price, contact.fullName, contact.phone, contact.altPhone || null,
      contact.building || null, contact.landmark || null, contact.street || null, contact.postalCode || null,
      contact.city || null, dropAddress, contact.deliveryDate || null, contact.deliverySlot || null, jsonNotes
    ]);

    if (saveAsDefault !== false && isNewAddress) {
      await connection.query("UPDATE addresses SET is_default = 0 WHERE user_id = ?", [user_id]);
      const uniqueLabel = `Address-${Date.now().toString().slice(-4)}`;
      const sqlAddress = `
        INSERT INTO addresses (user_id, label, full_name, phone, alt_phone, building, street, landmark, city, postal_code, full_address, is_default)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        ON DUPLICATE KEY UPDATE full_name = VALUES(full_name), phone = VALUES(phone), alt_phone = VALUES(alt_phone), building = VALUES(building), street = VALUES(street), landmark = VALUES(landmark), city = VALUES(city), postal_code = VALUES(postal_code), full_address = VALUES(full_address), is_default = 1
      `;
      await connection.query(sqlAddress, [user_id, uniqueLabel, contact.fullName || null, contact.phone || null, contact.altPhone || null, contact.building, contact.street, contact.landmark || null, contact.city, contact.postalCode, dropAddress]);
    } else if (saveAsDefault !== false && !isNewAddress) {
       await connection.query("UPDATE addresses SET is_default = 0 WHERE user_id = ?", [user_id]);
       await connection.query("UPDATE addresses SET is_default = 1 WHERE user_id = ? AND building = ? AND street = ?", [user_id, contact.building, contact.street]);
    }

    await connection.query("DELETE FROM cart WHERE user_id = ?", [user_id]);
    await connection.commit();
    connection.release();

    sendCheckoutEmail(total_price, contact, dropAddress, enrichedItems, contact.deliveryDate, contact.deliverySlot, formatOrderPlacedAt(orderPlacedAt));
    res.json({ success: true, order_id: result.insertId });
  } catch (err) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (rollbackErr) {
        console.error("Rollback failed:", rollbackErr.message);
      }
      connection.release();
    }
    console.error("Checkout failed:", err.message);
    res.status(500).json({ success: false, message: err.message || "Server error during checkout." });
  }
});

module.exports = router;