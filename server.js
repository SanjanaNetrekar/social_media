// server.js (UPDATED)
const express = require("express");
const mysql = require("mysql2");
const cors = require("cors");
const bcrypt = require("bcrypt");
const bodyParser = require("body-parser");
const path = require("path");
const multer = require("multer");
const fs = require("fs");

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static("public"));

const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use("/uploads", express.static(uploadsDir));

// Multer image storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => cb(null, Date.now() + "-" + file.originalname),
});
const upload = multer({ storage });

// MySQL connection
const db = mysql.createConnection({
  host: "localhost",
  user: "root",
  password: "sanjana@2802",
  database: "social_media",
});

db.connect((err) => {
  if (err) console.log("DB Error:", err);
  else console.log("Connected to DB");
});

// -------------------------------------
// REGISTER
// -------------------------------------
app.post("/register", async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ message: "All fields required" });

    const [exist] = await db.promise().query("SELECT id FROM users WHERE email = ?", [email]);
    if (exist.length > 0) return res.status(400).json({ message: "Email already used" });

    const hashed = await bcrypt.hash(password, 10);
    await db.promise().query("INSERT INTO users (name, email, password) VALUES (?, ?, ?)", [name, email, hashed]);
    res.json({ message: "Registered successfully" });
  } catch (err) {
    console.error("register:", err);
    res.status(500).json({ message: "Register failed" });
  }
});

// -------------------------------------
// LOGIN
// -------------------------------------
app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ message: "Email & password required" });

    const [rows] = await db.promise().query("SELECT * FROM users WHERE email = ?", [email]);
    if (rows.length === 0) return res.status(404).json({ message: "User not found" });

    const user = rows[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ message: "Wrong password" });

    // remove password before sending
    delete user.password;
    res.json({ message: "Login successful", user });
  } catch (err) {
    console.error("login:", err);
    res.status(500).json({ message: "Login failed" });
  }
});

// -------------------------------------
// ADD POST WITH TAGS + IMAGE
// -------------------------------------
// Accepts multipart/form-data with fields:
// - user_id (string/number)
// - content (string, optional)
// - tags (JSON array as string e.g. '["tag1","tag2"]' OR comma separated string)
// - image file under field name "image"
app.post("/addpost", upload.single("image"), async (req, res) => {
  try {
    let { user_id, content, tags } = req.body;
    user_id = Number(user_id) || null;
    const imageUrl = req.file ? `/uploads/${req.file.filename}` : null;

    if (!user_id) return res.status(400).json({ message: "User ID required" });
    if (!content && !imageUrl) return res.status(400).json({ message: "Content or image required" });

    const [postResult] = await db.promise().query(
      "INSERT INTO posts (user_id, content, image_url) VALUES (?, ?, ?)",
      [user_id, content || null, imageUrl]
    );

    const postId = postResult.insertId;

    // Normalize tags: allow JSON array or comma-separated string
    if (tags) {
      let tagList = [];
      if (typeof tags === "string") {
        try {
          const parsed = JSON.parse(tags);
          if (Array.isArray(parsed)) tagList = parsed;
          else tagList = tags.split(",").map(t => t.trim()).filter(Boolean);
        } catch {
          // not JSON, parse comma-separated
          tagList = tags.split(",").map(t => t.trim()).filter(Boolean);
        }
      } else if (Array.isArray(tags)) {
        tagList = tags;
      }

      for (const tag of tagList) {
        if (!tag) continue;
        await db.promise().query("INSERT IGNORE INTO tags (name) VALUES (?)", [tag]);
        const [tagRow] = await db.promise().query("SELECT id FROM tags WHERE name = ?", [tag]);
        if (tagRow.length) {
          const tagId = tagRow[0].id;
          await db.promise().query("INSERT IGNORE INTO post_tags (post_id, tag_id) VALUES (?, ?)", [postId, tagId]);
        }
      }
    }

    res.json({ message: "Post created", postId, imageUrl });
  } catch (err) {
    console.error("addpost:", err);
    res.status(500).json({ message: "Failed to add post" });
  }
});

// -------------------------------------
// GET ALL POSTS + TAGS
// -------------------------------------
app.get("/allposts", async (req, res) => {
  try {
    const [posts] = await db.promise().query(`
      SELECT p.id, p.user_id, p.content, p.image_url, p.created_at, u.name,
             (SELECT COUNT(*) FROM likes WHERE post_id=p.id) AS likes,
             (SELECT COUNT(*) FROM comments WHERE post_id=p.id) AS comments
      FROM posts p
      JOIN users u ON u.id=p.user_id
      ORDER BY p.created_at DESC
    `);

    const postIds = posts.map(p => p.id);
    if (postIds.length) {
      const [tagRows] = await db.promise().query(
        `SELECT pt.post_id, t.name FROM post_tags pt JOIN tags t ON pt.tag_id = t.id WHERE pt.post_id IN (?)`,
        [postIds]
      );
      const tagsMap = {};
      tagRows.forEach(r => {
        tagsMap[r.post_id] = tagsMap[r.post_id] || [];
        tagsMap[r.post_id].push(r.name);
      });
      posts.forEach(p => (p.tags = tagsMap[p.id] || []));
    } else {
      posts.forEach(p => (p.tags = []));
    }

    res.json(posts);
  } catch (err) {
    console.error("allposts:", err);
    res.status(500).json({ message: "Error fetching posts" });
  }
});

// -------------------------------------
// GET POSTS BY TAG
// -------------------------------------
app.get("/postsbytag/:tag", async (req, res) => {
  try {
    const tag = req.params.tag;
    const [rows] = await db.promise().query(
      `SELECT p.id, p.user_id, p.content, p.image_url, p.created_at, u.name,
              (SELECT COUNT(*) FROM likes WHERE post_id=p.id) AS likes,
              (SELECT COUNT(*) FROM comments WHERE post_id=p.id) AS comments
       FROM posts p
       JOIN post_tags pt ON p.id = pt.post_id
       JOIN tags t ON pt.tag_id = t.id
       JOIN users u ON p.user_id = u.id
       WHERE t.name = ?
       ORDER BY p.created_at DESC`,
      [tag]
    );

    // attach tags for these posts
    const ids = rows.map(r => r.id);
    if (ids.length) {
      const [ptRows] = await db.promise().query(
        `SELECT pt.post_id, t.name FROM post_tags pt JOIN tags t ON pt.tag_id = t.id WHERE pt.post_id IN (?)`,
        [ids]
      );
      const tm = {};
      ptRows.forEach(r => {
        tm[r.post_id] = tm[r.post_id] || [];
        tm[r.post_id].push(r.name);
      });
      rows.forEach(r => (r.tags = tm[r.id] || []));
    } else rows.forEach(r => (r.tags = []));

    res.json(rows);
  } catch (err) {
    console.error("postsbytag:", err);
    res.status(500).json({ message: "Error fetching posts by tag" });
  }
});

// -------------------------------------
// FOLLOW / UNFOLLOW (toggle)
// -------------------------------------
app.post("/follow", async (req, res) => {
  try {
    const { follower_id, following_id } = req.body;
    if (!follower_id || !following_id) return res.status(400).json({ message: "Missing follower_id or following_id" });

    const [exist] = await db.promise().query("SELECT id FROM followers WHERE follower_id=? AND following_id=?", [follower_id, following_id]);

    if (exist.length > 0) {
      await db.promise().query("DELETE FROM followers WHERE follower_id=? AND following_id=?", [follower_id, following_id]);
      return res.json({ message: "Unfollowed" });
    } else {
      await db.promise().query("INSERT INTO followers (follower_id, following_id) VALUES (?, ?)", [follower_id, following_id]);
      return res.json({ message: "Followed" });
    }
  } catch (err) {
    console.error("follow:", err);
    res.status(500).json({ message: "Error toggling follow" });
  }
});

// -------------------------------------
// CHECK FOLLOW STATUS (helper)
// -------------------------------------
app.get("/isfollowing/:follower/:followee", async (req, res) => {
  try {
    const follower = req.params.follower;
    const followee = req.params.followee;
    const [r] = await db.promise().query("SELECT id FROM followers WHERE follower_id=? AND following_id=?", [follower, followee]);
    res.json({ following: r.length > 0 });
  } catch (err) {
    console.error("isfollowing:", err);
    res.status(500).json({ message: "Error" });
  }
});

// -------------------------------------
// GET FOLLOWING & FOLLOWERS LIST
// -------------------------------------
app.get("/followers/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const [followers] = await db.promise().query(
      `SELECT u.id, u.name
       FROM followers f
       JOIN users u ON f.follower_id = u.id
       WHERE f.following_id = ?`,
      [id]
    );
    res.json(followers);
  } catch (err) {
    console.error("followers:", err);
    res.status(500).json({ message: "Error fetching followers" });
  }
});

app.get("/following/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const [following] = await db.promise().query(
      `SELECT u.id, u.name
       FROM followers f
       JOIN users u ON f.following_id = u.id
       WHERE f.follower_id = ?`,
      [id]
    );
    res.json(following);
  } catch (err) {
    console.error("following:", err);
    res.status(500).json({ message: "Error fetching following" });
  }
});

// -------------------------------------
// TAGS endpoints
// -------------------------------------
app.get("/api/tags", async (req, res) => {
  try {
    const [tags] = await db.promise().query("SELECT * FROM tags ORDER BY name");
    res.json(tags);
  } catch (err) {
    console.error("tags:", err);
    res.status(500).json({ message: "Error fetching tags" });
  }
});

// Create tag (optional)
app.post("/api/tags", async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ message: "Tag name required" });
    await db.promise().query("INSERT IGNORE INTO tags (name) VALUES (?)", [name]);
    res.json({ message: "Tag created/exists" });
  } catch (err) {
    console.error("create tag:", err);
    res.status(500).json({ message: "Error creating tag" });
  }
});

// -------------------------------------
// USERS endpoint
// -------------------------------------
app.get("/api/users", async (req, res) => {
  try {
    const [users] = await db.promise().query("SELECT id, name, email FROM users ORDER BY name");
    res.json(users);
  } catch (err) {
    console.error("users:", err);
    res.status(500).json({ message: "Error fetching users" });
  }
});

// -------------------------------------
// OTHER: comments / likes (if you already have these tables)
// Add endpoints if needed later
// -------------------------------------

// Serve pages (keep existing page serving; your frontend files should be in public/)
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/feed.html", (req, res) => res.sendFile(path.join(__dirname, "public", "feed.html")));
app.get("/posts.html", (req, res) => res.sendFile(path.join(__dirname, "public", "posts.html")));
app.get("/users.html", (req, res) => res.sendFile(path.join(__dirname, "public", "users.html")));
app.get("/tags.html", (req, res) => res.sendFile(path.join(__dirname, "public", "tags.html")));
app.get("/profile.html", (req, res) => res.sendFile(path.join(__dirname, "public", "profile.html")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
