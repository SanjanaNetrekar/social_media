// server.js
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

// uploads folder
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use("/uploads", express.static(uploadsDir));

// multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => cb(null, Date.now() + "-" + file.originalname),
});
const upload = multer({ storage });

// MySQL connection (update credentials if needed)
const db = mysql.createConnection({
  host: "localhost",
  user: "root",
  password: "sanjana@2802",
  database: "social_media",
});
db.connect((err) => {
  if (err) console.error("DB connect error:", err);
  else console.log("✅ MySQL connected");
});

// ----------------- AUTH USERS -----------------
app.post("/register", async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ message: "All fields required" });

    const [exist] = await db.promise().query("SELECT id FROM users WHERE email = ?", [email]);
    if (exist.length) return res.status(400).json({ message: "Email already registered" });

    const hash = await bcrypt.hash(password, 10);
    await db.promise().query("INSERT INTO users (name, email, password) VALUES (?, ?, ?)", [name, email, hash]);
    res.json({ message: "Registered" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Register failed" });
  }
});

app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ message: "Email & password required" });
    const [rows] = await db.promise().query("SELECT * FROM users WHERE email = ?", [email]);
    if (!rows.length) return res.status(404).json({ message: "User not found" });
    const user = rows[0];
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ message: "Invalid password" });
    delete user.password;
    res.json({ message: "Login successful", user: { id: user.id, name: user.name, email: user.email } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Login failed" });
  }
});

// ----------------- UPLOAD -----------------
// POST /upload (form-data with key 'image') -> returns { url: "/uploads/..." }
app.post("/upload", upload.single("image"), (req, res) => {
  if (!req.file) return res.status(400).json({ message: "No file uploaded" });
  const url = `/uploads/${req.file.filename}`;
  res.json({ url });
});

// ----------------- POSTS -----------------
app.post("/addpost", async (req, res) => {
  try {
    const { user_id, content, image_url, tags } = req.body; // tags optional (comma-separated or array)
    if (!user_id || (!content && !image_url)) return res.status(400).json({ message: "User & content or image required" });

    const [result] = await db.promise().query("INSERT INTO posts (user_id, content, image_url) VALUES (?, ?, ?)", [
      user_id,
      content || null,
      image_url || null,
    ]);
    const postId = result.insertId;

    // handle tags if provided (string or array)
    if (tags) {
      const tagList = Array.isArray(tags) ? tags : tags.split(",").map(t => t.trim()).filter(Boolean);
      for (const t of tagList) {
        const [existing] = await db.promise().query("SELECT id FROM tags WHERE name = ?", [t]);
        let tagId;
        if (existing.length) tagId = existing[0].id;
        else {
          const [r2] = await db.promise().query("INSERT INTO tags (name) VALUES (?)", [t]);
          tagId = r2.insertId;
        }
        await db.promise().query("INSERT IGNORE INTO post_tags (post_id, tag_id) VALUES (?, ?)", [postId, tagId]);
      }
    }

    res.json({ message: "Post created", postId });
  } catch (err) {
    console.error("addpost:", err);
    res.status(500).json({ message: "Failed to add post" });
  }
});

// get all posts (with counts + image + tags)
app.get("/allposts", async (req, res) => {
  try {
    const [posts] = await db.promise().query(
      `SELECT p.id, p.content, p.image_url, p.created_at, p.user_id, u.name,
              (SELECT COUNT(*) FROM likes WHERE post_id = p.id) AS likes,
              (SELECT COUNT(*) FROM comments WHERE post_id = p.id) AS comments
       FROM posts p JOIN users u ON p.user_id = u.id
       ORDER BY p.created_at DESC`
    );

    // fetch tags for all posts in one go
    const postIds = posts.map(p => p.id);
    let tagsMap = {};
    if (postIds.length) {
      const [pt] = await db.promise().query(
        `SELECT pt.post_id, t.name FROM post_tags pt JOIN tags t ON pt.tag_id = t.id WHERE pt.post_id IN (?)`,
        [postIds]
      );
      pt.forEach(r => {
        tagsMap[r.post_id] = tagsMap[r.post_id] || [];
        tagsMap[r.post_id].push(r.name);
      });
    }

    // attach tags
    posts.forEach(p => (p.tags = tagsMap[p.id] || []));

    res.json(posts);
  } catch (err) {
    console.error("allposts:", err);
    res.status(500).json({ message: "Error fetching posts" });
  }
});

// get posts by tag
app.get("/postsbytag/:tag", async (req, res) => {
  const tag = req.params.tag;
  try {
    const [rows] = await db.promise().query(
      `SELECT p.id, p.content, p.image_url, p.created_at, p.user_id, u.name,
              (SELECT COUNT(*) FROM likes WHERE post_id = p.id) AS likes,
              (SELECT COUNT(*) FROM comments WHERE post_id = p.id) AS comments
       FROM posts p
       JOIN post_tags pt ON p.id = pt.post_id
       JOIN tags t ON pt.tag_id = t.id
       JOIN users u ON p.user_id = u.id
       WHERE t.name = ?
       ORDER BY p.created_at DESC`,
      [tag]
    );

    // attach post tags (optional)
    const ids = rows.map(r => r.id);
    if (ids.length) {
      const [pt] = await db.promise().query(
        `SELECT pt.post_id, t.name FROM post_tags pt JOIN tags t ON pt.tag_id = t.id WHERE pt.post_id IN (?)`,
        [ids]
      );
      const tagsMap = {};
      pt.forEach(r => {
        tagsMap[r.post_id] = tagsMap[r.post_id] || [];
        tagsMap[r.post_id].push(r.name);
      });
      rows.forEach(r => (r.tags = tagsMap[r.id] || []));
    }

    res.json(rows);
  } catch (err) {
    console.error("postsbytag:", err);
    res.status(500).json({ message: "Error fetching by tag" });
  }
});

// ----------------- LIKES -----------------
app.post("/like", async (req, res) => {
  try {
    const { post_id, user_id } = req.body;
    if (!post_id || !user_id) return res.status(400).json({ message: "Missing" });

    const [ex] = await db.promise().query("SELECT id FROM likes WHERE post_id = ? AND user_id = ?", [post_id, user_id]);
    if (ex.length) {
      await db.promise().query("DELETE FROM likes WHERE id = ?", [ex[0].id]);
      return res.json({ message: "Unliked" });
    } else {
      await db.promise().query("INSERT INTO likes (post_id, user_id) VALUES (?, ?)", [post_id, user_id]);
      return res.json({ message: "Liked" });
    }
  } catch (err) {
    console.error("like:", err);
    res.status(500).json({ message: "Error liking" });
  }
});

// ----------------- COMMENTS -----------------
app.post("/comment", async (req, res) => {
  try {
    const { post_id, user_id, content } = req.body;
    if (!post_id || !user_id || !content) return res.status(400).json({ message: "Missing" });
    await db.promise().query("INSERT INTO comments (post_id, user_id, content) VALUES (?, ?, ?)", [post_id, user_id, content]);
    res.json({ message: "Comment added" });
  } catch (err) {
    console.error("comment:", err);
    res.status(500).json({ message: "Error commenting" });
  }
});

app.get("/comments/:post_id", async (req, res) => {
  try {
    const [rows] = await db.promise().query(
      `SELECT c.id, c.content, c.created_at, u.name
       FROM comments c JOIN users u ON c.user_id = u.id
       WHERE c.post_id = ?
       ORDER BY c.created_at DESC`,
      [req.params.post_id]
    );
    res.json(rows);
  } catch (err) {
    console.error("getcomments:", err);
    res.status(500).json({ message: "Error fetching comments" });
  }
});

// ----------------- FOLLOWERS -----------------
app.post("/follow", async (req, res) => {
  try {
    const { follower_id, followee_id } = req.body;
    if (!follower_id || !followee_id) return res.status(400).json({ message: "Missing" });
    await db.promise().query("INSERT IGNORE INTO followers (follower_id, followee_id) VALUES (?, ?)", [follower_id, followee_id]);
    res.json({ message: "Now following" });
  } catch (err) {
    console.error("follow:", err);
    res.status(500).json({ message: "Error following" });
  }
});
app.post("/unfollow", async (req, res) => {
  try {
    const { follower_id, followee_id } = req.body;
    await db.promise().query("DELETE FROM followers WHERE follower_id = ? AND followee_id = ?", [follower_id, followee_id]);
    res.json({ message: "Unfollowed" });
  } catch (err) {
    console.error("unfollow:", err);
    res.status(500).json({ message: "Error unfollowing" });
  }
});
app.get("/followers/:user_id", async (req, res) => {
  try {
    const [rows] = await db.promise().query(`SELECT u.id, u.name FROM followers f JOIN users u ON f.follower_id = u.id WHERE f.followee_id = ?`, [req.params.user_id]);
    res.json(rows);
  } catch (err) {
    console.error("followers:", err);
    res.status(500).json({ message: "Error" });
  }
});
app.get("/following/:user_id", async (req, res) => {
  try {
    const [rows] = await db.promise().query(`SELECT u.id, u.name FROM followers f JOIN users u ON f.followee_id = u.id WHERE f.follower_id = ?`, [req.params.user_id]);
    res.json(rows);
  } catch (err) {
    console.error("following:", err);
    res.status(500).json({ message: "Error" });
  }
});

// ----------------- MESSAGES (simple) -----------------
app.post("/message", async (req, res) => {
  try {
    const { sender_id, receiver_id, content } = req.body;
    if (!sender_id || !receiver_id) return res.status(400).json({ message: "Missing" });
    await db.promise().query("INSERT INTO messages (sender_id, receiver_id, message) VALUES (?, ?, ?)", [sender_id, receiver_id, content]);
    res.json({ message: "Message sent" });
  } catch (err) {
    console.error("message:", err);
    res.status(500).json({ message: "Error sending message" });
  }
});
app.get("/messages/:a/:b", async (req, res) => {
  try {
    const { a, b } = req.params;
    const [rows] = await db.promise().query(
      `SELECT m.id, m.message, m.created_at, s.name AS sender_name
       FROM messages m JOIN users s ON m.sender_id = s.id
       WHERE (sender_id=? AND receiver_id=?) OR (sender_id=? AND receiver_id=?)
       ORDER BY m.created_at ASC`,
      [a, b, b, a]
    );
    res.json(rows);
  } catch (err) {
    console.error("messages get:", err);
    res.status(500).json({ message: "Error fetching messages" });
  }
});

// ----------------- TAGS / POST_TAGS (create & list) -----------------
app.post("/createtag", async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ message: "Tag name required" });
    await db.promise().query("INSERT IGNORE INTO tags (name) VALUES (?)", [name]);
    res.json({ message: "Tag created/exists" });
  } catch (err) {
    console.error("createtag:", err);
    res.status(500).json({ message: "Error creating tag" });
  }
});
app.get("/tags", async (req, res) => {
  try {
    const [rows] = await db.promise().query("SELECT * FROM tags ORDER BY name");
    res.json(rows);
  } catch (err) {
    console.error("tags:", err);
    res.status(500).json({ message: "Error fetching tags" });
  }
});
app.post("/addtagtopost", async (req, res) => {
  try {
    const { post_id, tag_id } = req.body;
    if (!post_id || !tag_id) return res.status(400).json({ message: "Missing" });
    await db.promise().query("INSERT IGNORE INTO post_tags (post_id, tag_id) VALUES (?, ?)", [post_id, tag_id]);
    res.json({ message: "Tag added to post" });
  } catch (err) {
    console.error("addtagtopost:", err);
    res.status(500).json({ message: "Error adding tag to post" });
  }
});
app.get("/posttags/:post_id", async (req, res) => {
  try {
    const [rows] = await db.promise().query(`SELECT t.id, t.name FROM post_tags pt JOIN tags t ON pt.tag_id = t.id WHERE pt.post_id = ?`, [req.params.post_id]);
    res.json(rows);
  } catch (err) {
    console.error("posttags:", err);
    res.status(500).json({ message: "Error fetching post tags" });
  }
});

// ----------------- USERS LIST (helper) -----------------
app.get("/users", async (req, res) => {
  try {
    const [rows] = await db.promise().query("SELECT id, name, email FROM users ORDER BY name");
    res.json(rows);
  } catch (err) {
    console.error("users:", err);
    res.status(500).json({ message: "Error fetching users" });
  }
});

// ----------------- SERVE PAGES -----------------
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/feed", (req, res) => res.sendFile(path.join(__dirname, "public", "feed.html")));
app.get("/users", (req, res) => res.sendFile(path.join(__dirname, "public", "users.html")));
app.get("/tagspage", (req, res) => res.sendFile(path.join(__dirname, "public", "tags.html")));

// ----------------- START -----------------
const PORT = 3000;
app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));
