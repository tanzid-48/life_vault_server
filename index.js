require("dotenv").config();
const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 5000;
const { MongoClient, ServerApiVersion } = require("mongodb");

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("LifeVault API is running!");
});

const uri = process.env.MONGODB_URI;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    await client.connect();
    const db = client.db("life_vault_db");
    const usersCollection = db.collection("user");
    const lessonsCollection = db.collection("lessons");

    // ── LESSONS

    // POST /lessons — create [auth]
    // verifyToken মিডলওয়্যারটি এখানে আর নেই
    app.post("/lessons", async (req, res) => {
      try {
        const {
          title,
          description,
          category,
          emotionalTone,
          accessLevel,
          imageUrl,
          userId, // সরাসরি রিকোয়েস্ট বডি থেকে নিচ্ছি
          userName,
          userAvatar,
        } = req.body;

        // ১. ভ্যালিডেশন
        if (
          !title?.trim() ||
          !description?.trim() ||
          !category ||
          !emotionalTone
        ) {
          return res
            .status(400)
            .json({ message: "All required fields are mandatory" });
        }

        // ২. অবজেক্ট তৈরি
        const newLesson = {
          title: title.trim(),
          description: description.trim(),
          category,
          emotionalTone,
          accessLevel: accessLevel || "free",
          imageUrl: imageUrl || null,
          userId: userId || "anonymous", 
          userName: userName || "Anonymous User",
          userAvatar: userAvatar || null,
          isPublic: true,
          views: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        
        const result = await lessonsCollection.insertOne(newLesson);

        res.status(201).json({
          success: true,
          message: "Lesson created successfully",
          insertedId: result.insertedId,
        });
      } catch (err) {
        console.error("Error creating lesson:", err);
        res.status(500).json({ message: "Internal server error" });
      }
    });
    // GET /lessons — paginated + filter (public)
    app.get("/lessons", async (req, res) => {
      try {
        const {
          page,
          limit = "9",
          search,
          category,
          emotionalTone,
          accessLevel,
          userId,
          sort,
        } = req.query;

        const query = { isPublic: true };
        if (category) query.category = category;
        if (emotionalTone) query.emotionalTone = emotionalTone;
        if (accessLevel) query.accessLevel = accessLevel;
        if (userId) query.userId = userId;
        if (search) {
          query.$or = [
            { title: { $regex: search, $options: "i" } },
            { description: { $regex: search, $options: "i" } },
            { category: { $regex: search, $options: "i" } },
          ];
        }

        const sortObj =
          sort === "popular"
            ? { views: -1 }
            : sort === "oldest"
              ? { createdAt: 1 }
              : { createdAt: -1 }; // newest (default)

        // Paginated
        if (page) {
          const pageNum = Math.max(1, parseInt(page));
          const limitNum = Math.max(1, parseInt(limit));
          const skip = (pageNum - 1) * limitNum;

          const [lessons, total] = await Promise.all([
            lessonsCollection
              .find(query)
              .sort(sortObj)
              .skip(skip)
              .limit(limitNum)
              .toArray(),
            lessonsCollection.countDocuments(query),
          ]);

          return res.json({
            lessons,
            total,
            totalPages: Math.ceil(total / limitNum),
            page: pageNum,
          });
        }

        // All (backward compat)
        const lessons = await lessonsCollection
          .find(query)
          .sort(sortObj)
          .toArray();
        res.json(lessons);
      } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Server error" });
      }
    });

    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!",
    );
  } finally {
    // await client.close();
  }
}
run().catch(console.dir);

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
