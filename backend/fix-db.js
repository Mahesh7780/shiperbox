const db = require("./db");

async function fixDB() {
  try {
    console.log("Adding otps table...");
    await db.query(`
      CREATE TABLE IF NOT EXISTS otps (
        email VARCHAR(255) PRIMARY KEY,
        otp VARCHAR(10) NOT NULL,
        expires_at BIGINT NOT NULL
      )
    `);
    
    console.log("Checking constraints...");
    // users table email unique constraint
    try {
      await db.query(`ALTER TABLE users ADD UNIQUE (email)`);
      console.log("Added UNIQUE constraint on users.email");
    } catch (e) {
      console.log("Constraint on users.email might already exist:", e.message);
    }

    // cart table unique constraint
    try {
      await db.query(`ALTER TABLE cart ADD UNIQUE (user_id, product_id)`);
      console.log("Added UNIQUE constraint on cart (user_id, product_id)");
    } catch (e) {
      console.log("Constraint on cart might already exist:", e.message);
    }

    console.log("Database fixes applied successfully.");
    process.exit(0);
  } catch (err) {
    console.error("Error fixing database:", err);
    process.exit(1);
  }
}

fixDB();
