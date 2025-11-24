require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const bcrypt = require("bcrypt");
const db = require("./db");

// NEW: http + socket.io
const http = require("http");
const { Server } = require("socket.io");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// create http server
const server = http.createServer(app);

// socket.io server
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

// map of userId -> Set(socketIds)
const onlineUsers = new Map();

// SOCKET.IO EVENTS
io.on("connection", (socket) => {
  socket.on("register", (userId) => {
    if (!userId) return;
    const key = String(userId);
    const set = onlineUsers.get(key) || new Set();
    set.add(socket.id);
    onlineUsers.set(key, set);
    socket.join("user_" + key);
    io.emit("user_online", { userId: Number(key) });
  });

  socket.on("typing", (payload) => {
    if (!payload || !payload.to) return;
    io.to("user_" + payload.to).emit("typing", { from: payload.from });
  });

  socket.on("send_message", async (payload) => {
    try {
      const { sender_id, receiver_id, content, image_url } = payload || {};
      if (!sender_id || !receiver_id) return;

      const [r] = await db.query(
        "INSERT INTO messages(sender_id,receiver_id,content,image_url) VALUES (?,?,?,?)",
        [sender_id, receiver_id, content, image_url]
      );

      const [u] = await db.query("SELECT name FROM users WHERE id=?", [sender_id]);
      const sender_name = (u && u[0] && u[0].name) || "User";

      const msg = {
        id: r.insertId,
        sender_id,
        receiver_id,
        content,
        image_url,
        created_at: new Date().toISOString(),
        sender_name,
      };

      io.to("user_" + receiver_id).emit("private_message", msg);

      const senderSockets = onlineUsers.get(String(sender_id));
      if (senderSockets) {
        for (const sid of senderSockets) io.to(sid).emit("message_sent", msg);
      }
    } catch (e) {
      console.error("socket send_message failed", e);
    }
  });

  socket.on("disconnect", () => {
    for (const [userId, sset] of onlineUsers.entries()) {
      if (sset.has(socket.id)) {
        sset.delete(socket.id);
        if (sset.size === 0) {
          onlineUsers.delete(userId);
          io.emit("user_offline", { userId: Number(userId) });
        } else {
          onlineUsers.set(userId, sset);
        }
        break;
      }
    }
  });
});
/* ======================================================================
   STATIC FILES / UPLOADS
====================================================================== */
const PUBLIC_DIR = path.join(__dirname, "public");
app.use(express.static(PUBLIC_DIR));

const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use("/uploads", express.static(uploadsDir));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) =>
    cb(null, Date.now() + "-" + file.originalname.replace(/\s+/g, "_")),
});
const upload = multer({ storage });

/* ======================================================================
   AUTH
====================================================================== */
app.post("/register", async (req, res) => {
  try {
    const { name, email, password, avatar } = req.body;
    if (!name || !email || !password)
      return res.status(400).json({ message: "All fields required" });

    const [exists] = await db.query("SELECT id FROM users WHERE email = ?", [email]);
    if (exists.length)
      return res.status(400).json({ message: "Email already exists" });

    const hash = await bcrypt.hash(password, 10);

    const [result] = await db.query(
      "INSERT INTO users(name,email,password,avatar) VALUES (?,?,?,?)",
      [name, email, hash, avatar || null]
    );

    res.json({ message: "Registered", userId: result.insertId });
  } catch (e) {
    console.log(e);
    res.status(500).json({ message: "Register failed" });
  }
});

app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const [rows] = await db.query("SELECT * FROM users WHERE email = ?", [email]);

    if (!rows.length)
      return res.status(404).json({ message: "Email not registered" });

    const user = rows[0];
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ message: "Wrong password" });

    const safeUser = {
      id: user.id,
      name: user.name,
      email: user.email,
      avatar: user.avatar,
    };

    res.json({ message: "Login successful", user: safeUser });
  } catch (e) {
    res.status(500).json({ message: "Login failed" });
  }
});

/* ======================================================================
   UPLOADS
====================================================================== */
app.post("/upload", upload.single("image"), (req, res) => {
  if (!req.file) return res.status(400).json({ message: "No file uploaded" });
  res.json({ url: "/uploads/" + req.file.filename });
});

/* ======================================================================
   POSTS
====================================================================== */
app.post("/addpost", async (req, res) => {
  try {
    const { user_id, content, image_url } = req.body;

    const [r] = await db.query(
      "INSERT INTO posts(user_id,content,image_url) VALUES (?,?,?)",
      [user_id, content, image_url]
    );

    // Notify followers in real-time
    const [followers] = await db.query(
      "SELECT follower_id FROM followers WHERE followee_id=?",
      [user_id]
    );

    const note = {
      type: "new_post",
      postId: r.insertId,
      user_id,
      content,
      image_url,
    };

    followers.forEach((f) => {
      io.to("user_" + f.follower_id).emit("notification", note);
    });

    res.json({ message: "Post added", postId: r.insertId });
  } catch (e) {
    console.log(e);
    res.status(500).json({ message: "Post creation failed" });
  }
});

app.get("/allposts", async (req, res) => {
  try {
    const [posts] = await db.query(
      `SELECT p.id,p.content,p.image_url,p.created_at,p.user_id,
              u.name,u.avatar,
              (SELECT COUNT(*) FROM likes WHERE post_id=p.id) AS likes,
              (SELECT COUNT(*) FROM comments WHERE post_id=p.id) AS comments
       FROM posts p
       JOIN users u ON p.user_id=u.id
       ORDER BY p.created_at DESC`
    );

    const ids = posts.map((p) => p.id);

    if (ids.length > 0) {
      const [tags] = await db.query(
        `SELECT pt.post_id,t.name 
         FROM post_tags pt 
         JOIN tags t ON pt.tag_id=t.id 
         WHERE pt.post_id IN (?)`,
        [ids]
      );

      const map = {};
      tags.forEach((t) => {
        map[t.post_id] = map[t.post_id] || [];
        map[t.post_id].push(t.name);
      });

      posts.forEach((p) => (p.tags = map[p.id] || []));
    }

    res.json(posts);
  } catch (e) {
    console.log(e);
    res.status(500).json({ message: "Failed to load posts" });
  }
});

app.delete("/deletepost/:id", async (req, res) => {
  try {
    const id = req.params.id;

    await db.query("DELETE FROM post_tags WHERE post_id=?", [id]);
    await db.query("DELETE FROM likes WHERE post_id=?", [id]);
    await db.query("DELETE FROM comments WHERE post_id=?", [id]);
    await db.query("DELETE FROM posts WHERE id=?", [id]);

    res.json({ message: "Deleted" });
  } catch (e) {
    res.status(500).json({ message: "Delete failed" });
  }
});

/* ======================================================================
   LIKES — realtime notification to post owner
====================================================================== */
app.post("/like", async (req, res) => {
  try {
    const { post_id, user_id } = req.body;

    const [exists] = await db.query(
      "SELECT id FROM likes WHERE post_id=? AND user_id=?",
      [post_id, user_id]
    );

    if (exists.length) {
      await db.query("DELETE FROM likes WHERE id=?", [exists[0].id]);
      return res.json({ message: "Unliked" });
    }

    await db.query("INSERT INTO likes(post_id,user_id) VALUES(?,?)", [
      post_id,
      user_id,
    ]);

    // find owner
    const [p] = await db.query("SELECT user_id FROM posts WHERE id=?", [post_id]);

    if (p && p[0]) {
      const ownerId = p[0].user_id;

      const [u] = await db.query("SELECT name FROM users WHERE id=?", [user_id]);
      const fromName = (u && u[0] && u[0].name) || "Someone";

      const note = {
        type: "like",
        from: user_id,
        fromName,
        post_id,
      };

      io.to("user_" + ownerId).emit("notification", note);
    }

    res.json({ message: "Liked" });
  } catch (e) {
    console.log(e);
    res.status(500).json({ message: "Like failed" });
  }
});
/* ======================================================================
   COMMENTS — realtime notification
====================================================================== */
app.post("/comment", async (req, res) => {
  try {
    const { post_id, user_id, content } = req.body;

    await db.query(
      "INSERT INTO comments(post_id,user_id,content) VALUES (?,?,?)",
      [post_id, user_id, content]
    );

    // notify post owner
    const [p] = await db.query("SELECT user_id FROM posts WHERE id=?", [
      post_id,
    ]);

    if (p && p[0]) {
      const ownerId = p[0].user_id;

      const [u] = await db.query(
        "SELECT name FROM users WHERE id=?",
        [user_id]
      );
      const fromName = (u && u[0] && u[0].name) || "Someone";

      const note = {
        type: "comment",
        from: user_id,
        fromName,
        post_id,
        content,
      };

      io.to("user_" + ownerId).emit("notification", note);
    }

    res.json({ message: "Comment added" });
  } catch (e) {
    console.log(e);
    res.status(500).json({ message: "Comment failed" });
  }
});

/* ======================================================================
   FOLLOW / UNFOLLOW
====================================================================== */
app.post("/follow", async (req, res) => {
  try {
    const { follower_id, followee_id } = req.body;

    await db.query(
      "INSERT IGNORE INTO followers(follower_id,followee_id) VALUES (?,?)",
      [follower_id, followee_id]
    );

    // notify
    const [u] = await db.query("SELECT name FROM users WHERE id=?", [
      follower_id,
    ]);
    const fromName = (u && u[0] && u[0].name) || "Someone";

    const note = { type: "follow", from: follower_id, fromName };

    io.to("user_" + followee_id).emit("notification", note);

    res.json({ message: "Followed" });
  } catch (e) {
    res.status(500).json({ message: "Follow failed" });
  }
});

app.post("/unfollow", async (req, res) => {
  try {
    const { follower_id, followee_id } = req.body;

    await db.query(
      "DELETE FROM followers WHERE follower_id=? AND followee_id=?",
      [follower_id, followee_id]
    );

    res.json({ message: "Unfollowed" });
  } catch (e) {
    res.status(500).json({ message: "Unfollow failed" });
  }
});

/* ======================================================================
   FOLLOWERS LIST
====================================================================== */
app.get("/followers/:id", async (req, res) => {
  try {
    const id = req.params.id;

    const [rows] = await db.query(
      `SELECT u.id,u.name,u.email,u.avatar 
       FROM followers f
       JOIN users u ON f.follower_id=u.id
       WHERE f.followee_id=?`,
      [id]
    );

    res.json(rows);
  } catch (e) {
    res.status(500).json({ message: "Followers load failed" });
  }
});

app.get("/following/:id", async (req, res) => {
  try {
    const id = req.params.id;

    const [rows] = await db.query(
      `SELECT u.id,u.name,u.email,u.avatar 
       FROM followers f
       JOIN users u ON f.followee_id=u.id
       WHERE f.follower_id=?`,
      [id]
    );

    res.json(rows);
  } catch (e) {
    res.status(500).json({ message: "Following load failed" });
  }
});

app.get("/isfollowing/:me/:other", async (req, res) => {
  try {
    const { me, other } = req.params;

    const [rows] = await db.query(
      "SELECT id FROM followers WHERE follower_id=? AND followee_id=?",
      [me, other]
    );

    res.json({ following: rows.length > 0 });
  } catch (e) {
    res.status(500).json({ message: "Follow check failed" });
  }
});

/* ======================================================================
   MESSAGES (FIXED — uses content)
====================================================================== */
app.post("/message", async (req, res) => {
  try {
    const { sender_id, receiver_id, content, image_url } = req.body;

    const [r] = await db.query(
      "INSERT INTO messages(sender_id,receiver_id,content,image_url) VALUES (?,?,?,?)",
      [sender_id, receiver_id, content, image_url]
    );

    const [u] = await db.query("SELECT name FROM users WHERE id=?", [
      sender_id,
    ]);
    const sender_name = (u && u[0] && u[0].name) || "User";

    const msg = {
      id: r.insertId,
      sender_id,
      receiver_id,
      content,
      image_url,
      created_at: new Date().toISOString(),
      sender_name,
    };

    // send private message
    io.to("user_" + receiver_id).emit("private_message", msg);

    // notify inbox
    io.to("user_" + receiver_id).emit("notification", {
      type: "message",
      from: sender_id,
      fromName: sender_name,
      messageId: r.insertId,
    });

    // ack to sender
    const set = onlineUsers.get(String(sender_id));
    if (set) {
      for (const sid of set) {
        io.to(sid).emit("message_sent", msg);
      }
    }

    res.json({ message: "Sent" });
  } catch (e) {
    console.log(e);
    res.status(500).json({ message: "Message failed" });
  }
});

app.get("/messages/:a/:b", async (req, res) => {
  try {
    const { a, b } = req.params;

    const [rows] = await db.query(
      `SELECT m.id,m.content,m.image_url,m.created_at,
              m.sender_id,
              u.name AS sender_name
       FROM messages m
       JOIN users u ON m.sender_id=u.id
       WHERE (sender_id=? AND receiver_id=?) 
          OR (sender_id=? AND receiver_id=?)
       ORDER BY created_at ASC`,
      [a, b, b, a]
    );

    res.json(rows);
  } catch (e) {
    res.status(500).json({ message: "Messages load failed" });
  }
});

/* ======================================================================
   TAGS
====================================================================== */
app.post("/createtag", async (req, res) => {
  try {
    await db.query("INSERT IGNORE INTO tags(name) VALUES (?)", [
      req.body.name,
    ]);
    res.json({ message: "Tag saved" });
  } catch (e) {
    res.status(500).json({ message: "Tag failed" });
  }
});

app.get("/tags", async (req, res) => {
  const [rows] = await db.query("SELECT * FROM tags ORDER BY name");
  res.json(rows);
});

app.get("/postsbytag/:name", async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT p.*,u.name,u.avatar FROM posts p
       JOIN post_tags pt ON p.id=pt.post_id
       JOIN tags t ON pt.tag_id=t.id
       JOIN users u ON p.user_id=u.id
       WHERE t.name=?
       ORDER BY p.created_at DESC`,
      [req.params.name]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ message: "Tag posts failed" });
  }
});

/* ======================================================================
   USERS + PROFILE
====================================================================== */
app.get("/users", async (req, res) => {
  const [rows] = await db.query(
    "SELECT id,name,email,avatar FROM users ORDER BY name"
  );
  res.json(rows);
});

app.get("/userposts/:id", async (req, res) => {
  const [rows] = await db.query(
    "SELECT * FROM posts WHERE user_id=? ORDER BY created_at DESC",
    [req.params.id]
  );
  res.json(rows);
});

app.put("/user/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const { name, email, password, avatar } = req.body;

    if (!name || !email)
      return res.status(400).json({ message: "Name & email required" });

    const [others] = await db.query(
      "SELECT id FROM users WHERE email=? AND id!=?",
      [email, id]
    );
    if (others.length)
      return res.status(400).json({ message: "Email already used" });

    if (password) {
      const hash = await bcrypt.hash(password, 10);
      await db.query(
        "UPDATE users SET name=?,email=?,password=?,avatar=? WHERE id=?",
        [name, email, hash, avatar || null, id]
      );
    } else {
      await db.query(
        "UPDATE users SET name=?,email=?,avatar=? WHERE id=?",
        [name, email, avatar || null, id]
      );
    }

    const [user] = await db.query(
      "SELECT id,name,email,avatar FROM users WHERE id=?",
      [id]
    );

    res.json({ message: "Updated", user: user[0] });
  } catch (e) {
    res.status(500).json({ message: "Update failed" });
  }
});

// === Compatibility & story upload endpoints (ADD THIS) ===
// Add this near your other endpoints (above the server listen call).

// POST /updateUser - compatibility alias for older frontends
app.post('/updateUser', async (req, res) => {
  try {
    const payload = req.body || {};
    const id = payload.id;
    if (!id) return res.status(400).json({ message: 'Missing id' });

    let name = payload.name || null;
    let email = payload.email || null;
    const password = payload.password || null;
    const avatar = payload.avatar || payload.image || null;

    // If password provided, hash & update it
    if (password) {
      const hash = await bcrypt.hash(password, 10);
      await db.query('UPDATE users SET name=?, email=?, password=?, avatar=? WHERE id=?', [name, email, hash, avatar, id]);
    } else {
      // Keep existing email if not provided
      if (!email) {
        const [rows] = await db.query('SELECT email FROM users WHERE id=?', [id]);
        if (rows && rows[0]) email = rows[0].email;
      }
      await db.query('UPDATE users SET name=?, email=?, avatar=? WHERE id=?', [name, email, avatar, id]);
    }

    const [userRows] = await db.query('SELECT id,name,email,avatar FROM users WHERE id=?', [id]);
    res.json({ message: 'Updated', user: (userRows && userRows[0]) || null });
  } catch (e) {
    console.error('updateUser failed', e);
    res.status(500).json({ message: 'Update failed' });
  }
});

// POST /uploadstory - upload image and optionally persist a stories row
// (re-uses your existing multer `upload` middleware; ensure `upload` is defined in server.js)
app.post('/uploadstory', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });
    const url = '/uploads/' + req.file.filename;
    const user_id = req.body.user_id || null;

    // Try to insert a story row if a stories table exists. If it doesn't, ignore the error.
    if (user_id) {
      try {
        await db.query('INSERT INTO stories (user_id, image_url, created_at) VALUES (?, ?, NOW())', [user_id, url]);
      } catch (err) {
        // Table may not exist — ignore but log
        console.warn('Could not insert story row (table may be missing):', err.message);
      }
    }

    res.json({ message: 'Story uploaded', url });
  } catch (e) {
    console.error('uploadstory failed', e);
    res.status(500).json({ message: 'Story upload failed' });
  }
});

// ================= STORY UPLOAD ==================
app.post("/uploadstory", upload.single("image"), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ message: "No image provided" });
        }
        // Path to uploaded file
        const url = "/uploads/" + req.file.filename;
        res.json({ url: url });
    } catch (err) {
        console.error("Story Upload Error:", err);
        res.status(500).json({ message: "Story upload failed" });
    }
});
// ================= ADD STORY ==================
app.post("/addstory", async (req, res) => {
    try {
        const { user_id, image_url, caption, expires_at } = req.body;

        if (!user_id || !image_url) {
            return res.status(400).json({ message: "Missing required fields" });
        }

        const query = `
            INSERT INTO stories (user_id, image_url, caption, expires_at)
            VALUES (?, ?, ?, ?)
        `;

        const values = [
            user_id,
            image_url,
            caption || null,
            expires_at || null
        ];

        const [result] = await db.execute(query, values);

        const [story] = await db.execute(
            "SELECT * FROM stories WHERE id = ?",
            [result.insertId]
        );

        res.json({ story: story[0] });
    } catch (err) {
        console.error("Add Story Error:", err);
        res.status(500).json({ message: "Failed to add story" });
    }
});
// ================= GET STORIES ==================
app.get("/stories", async (req, res) => {
    try {
        const query = `
            SELECT s.*, u.name, u.avatar 
            FROM stories s
            JOIN users u ON s.user_id = u.id
            WHERE s.expires_at IS NULL OR s.expires_at > NOW()
            ORDER BY s.created_at DESC
        `;

        const [rows] = await db.execute(query);
        res.json(rows);
    } catch (err) {
        console.error("Get Stories Error:", err);
        res.status(500).json({ message: "Could not load stories" });
    }
});

/* ======================================================================
   START SERVER
====================================================================== */
const PORT = process.env.PORT || 3000;
server.listen(PORT, () =>
  console.log(`Server running on http://localhost:${PORT}`)
);
