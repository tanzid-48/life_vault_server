require("dotenv").config();
const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 5000;
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

app.use(
  cors({
    origin: process.env.CLIENT_URL,
    credentials: true,
  }),
);

// Stripe webhook — /webhook
app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    const secret = process.env.STRIPE_WEBHOOK_SECRET;

    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, secret);
    } catch (err) {
      console.error("Webhook error:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const userId = session.metadata?.userId;

      if (userId) {
        await usersCollection.updateOne(
          { _id: new ObjectId(userId) },
          { $set: { isPremium: true, premiumSince: new Date() } },
        );
        console.log("✅ Premium activated for:", userId);
      }
    }

    res.json({ received: true });
  },
);

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
    const sessionCollection = db.collection("session");

    const lessonsCollection = db.collection("lessons");
    const favoritesCollection = db.collection("favorites");
    const commentsCollection = db.collection("comments");
    const reportsCollection = db.collection("reports");

    // ── verifyToken middleware
    const verifyToken = async (req, res, next) => {
      const authHeader = req.headers?.authorization;
      if (!authHeader) return res.status(401).json({ message: "Unauthorized" });

      const token = authHeader.split(" ")[1];
      if (!token) return res.status(401).json({ message: "Unauthorized" });

      const session = await sessionCollection.findOne({ token });
      if (!session) return res.status(401).json({ message: "Unauthorized" });

      const user = await usersCollection.findOne({
        _id: new ObjectId(session.userId),
      });
      if (!user) return res.status(401).json({ message: "Unauthorized" });

      req.user = user;
      next();
    };

    const verifyAdmin = (req, res, next) => {
      if (req.user?.role !== "admin")
        return res.status(403).json({ message: "Forbidden" });
      next();
    };
     
    //user/premium
    app.patch("/users/:id/premium", async (req, res) => {
      try {
        const { isPremium } = req.body;
        await usersCollection.updateOne(
          { _id: new ObjectId(req.params.id) },
          { $set: { isPremium, premiumSince: isPremium ? new Date() : null } },
        );
        res.json({ success: true });
      } catch {
        res.status(500).json({ message: "Server error" });
      }
    });

    // ── LESSONS

    // POST /lessons — create
    app.post("/lessons", async (req, res) => {
      try {
        const {
          title,
          description,
          category,
          emotionalTone,
          accessLevel,
          imageUrl,
          userId,
          userName,
          userAvatar,
        } = req.body;

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
          likes: [],
          likesCount: 0,
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

    // GET /lessons — paginated + filter
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
              : { createdAt: -1 };

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

    // GET /lessons/:id
    app.get("/lessons/:id", async (req, res) => {
      try {
        const lesson = await lessonsCollection.findOne({
          _id: new ObjectId(req.params.id),
        });
        if (!lesson)
          return res.status(404).json({ message: "Lesson not found" });
        res.json(lesson);
      } catch {
        res.status(500).json({ message: "Server error" });
      }
    });

    // POST /lessons/:id/like — increment-only (auth)

    app.post("/lessons/:id/like", verifyToken, async (req, res) => {
      try {
        const userId = req.user._id.toString();
        const lesson = await lessonsCollection.findOne({
          _id: new ObjectId(req.params.id),
        });
        if (!lesson) return res.status(404).json({ message: "Not found" });

        const likes = lesson.likes ?? [];
        const alreadyLiked = likes.includes(userId);

        if (alreadyLiked) {
          return res.json({
            success: true,
            liked: true,
            likesCount: lesson.likesCount ?? likes.length,
          });
        }

        const updated = await lessonsCollection.findOneAndUpdate(
          { _id: new ObjectId(req.params.id) },
          { $addToSet: { likes: userId }, $inc: { likesCount: 1 } },
          { returnDocument: "after" },
        );

        res.json({
          success: true,
          liked: true,
          likesCount: updated.likesCount ?? 0,
        });
      } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Server error" });
      }
    });

    // ── FAVORITES

    // POST /favorites/:lessonId — toggle (auth)
    app.post("/favorites/:lessonId", verifyToken, async (req, res) => {
      try {
        const userId = req.user._id.toString();
        const { lessonId } = req.params;

        const existing = await favoritesCollection.findOne({
          userId,
          lessonId,
        });
        if (existing) {
          await favoritesCollection.deleteOne({ userId, lessonId });
          return res.json({ success: true, saved: false });
        }
        await favoritesCollection.insertOne({
          userId,
          lessonId,
          createdAt: new Date(),
        });
        res.json({ success: true, saved: true });
      } catch {
        res.status(500).json({ message: "Server error" });
      }
    });

    // GET /favorites/:lessonId/status (auth)
    app.get("/favorites/:lessonId/status", verifyToken, async (req, res) => {
      try {
        const userId = req.user._id.toString();
        const existing = await favoritesCollection.findOne({
          userId,
          lessonId: req.params.lessonId,
        });
        res.json({ saved: !!existing });
      } catch {
        res.status(500).json({ message: "Server error" });
      }
    });

    // GET /favorites?userId=xxx — user-এর সব favorites
    app.get("/favorites", verifyToken, async (req, res) => {
      try {
        const userId = req.user._id.toString();
        const result = await favoritesCollection.find({ userId }).toArray();
        res.json(result);
      } catch {
        res.status(500).json({ message: "Server error" });
      }
    });

    // ── COMMENTS

    // GET /comments?lessonId=xxx
    app.get("/comments", async (req, res) => {
      try {
        const { lessonId } = req.query;
        if (!lessonId) return res.json([]);
        const result = await commentsCollection
          .find({ lessonId })
          .sort({ createdAt: -1 })
          .toArray();
        res.json(result);
      } catch {
        res.status(500).json({ message: "Server error" });
      }
    });

    // POST /comments (auth)
    app.post("/comments", verifyToken, async (req, res) => {
      try {
        const { lessonId, content } = req.body;
        if (!lessonId || !content?.trim())
          return res
            .status(400)
            .json({ message: "lessonId and content required" });

        const comment = {
          lessonId,
          content: content.trim(),
          userId: req.user._id.toString(),
          userName: req.user.name,
          userAvatar: req.user.image ?? null,
          createdAt: new Date(),
        };
        const result = await commentsCollection.insertOne(comment);
        res.status(201).json({
          success: true,
          comment: { ...comment, _id: result.insertedId },
        });
      } catch {
        res.status(500).json({ message: "Server error" });
      }
    });

    // ── REPORTS

    // POST /reports (auth)
    app.post("/reports", verifyToken, async (req, res) => {
      try {
        const { lessonId, reason } = req.body;
        if (!lessonId || !reason)
          return res
            .status(400)
            .json({ message: "lessonId and reason required" });

        const existing = await reportsCollection.findOne({
          lessonId,
          reporterUserId: req.user._id.toString(),
        });
        if (existing)
          return res
            .status(400)
            .json({ message: "You have already reported this lesson" });

        await reportsCollection.insertOne({
          lessonId,
          reporterUserId: req.user._id.toString(),
          reporterEmail: req.user.email,
          reason,
          createdAt: new Date(),
        });
        res.json({ success: true });
      } catch {
        res.status(500).json({ message: "Server error" });
      }
    });

    // ── ADMIN

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
