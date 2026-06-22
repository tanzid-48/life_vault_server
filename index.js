require("dotenv").config();
const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 5000;
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const Stripe = require("stripe");
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

app.use(
  cors({
    origin: process.env.CLIENT_URL,
    credentials: true,
  }),
);

let usersCollection;

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

      if (userId && usersCollection) {
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

    usersCollection = db.collection("user");
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

        const pageNum = Math.max(1, parseInt(page) || 1);
        const limitNum = Math.max(1, parseInt(limit));
        const skip = (pageNum - 1) * limitNum;

        // sort=mostSaved — favorites collection
        if (sort === "mostSaved") {
          const basePipeline = [
            { $match: query },
            { $addFields: { idStr: { $toString: "$_id" } } },
            {
              $lookup: {
                from: "favorites",
                localField: "idStr",
                foreignField: "lessonId",
                as: "favoritesArr",
              },
            },
            { $addFields: { favoritesCount: { $size: "$favoritesArr" } } },
            { $project: { favoritesArr: 0, idStr: 0 } },
            { $sort: { favoritesCount: -1 } },
          ];

          const [lessons, countResult] = await Promise.all([
            lessonsCollection
              .aggregate([
                ...basePipeline,
                { $skip: skip },
                { $limit: limitNum },
              ])
              .toArray(),
            lessonsCollection
              .aggregate([{ $match: query }, { $count: "total" }])
              .toArray(),
          ]);

          const total = countResult[0]?.total ?? 0;

          if (page) {
            return res.json({
              lessons,
              total,
              totalPages: Math.ceil(total / limitNum),
              page: pageNum,
            });
          }
          return res.json(lessons);
        }

        // ── newest / oldest / popular
        const sortObj =
          sort === "popular"
            ? { views: -1 }
            : sort === "oldest"
              ? { createdAt: 1 }
              : { createdAt: -1 };

        if (page) {
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

    // PATCH /lessons/:id — update (owner only)
    app.patch("/lessons/:id", verifyToken, async (req, res) => {
      try {
        const lesson = await lessonsCollection.findOne({
          _id: new ObjectId(req.params.id),
        });
        if (!lesson) return res.status(404).json({ message: "Not found" });

        // Only owner can update
        if (lesson.userId !== req.user._id.toString()) {
          return res.status(403).json({ message: "Forbidden" });
        }

        const result = await lessonsCollection.findOneAndUpdate(
          { _id: new ObjectId(req.params.id) },
          { $set: { ...req.body, updatedAt: new Date() } },
          { returnDocument: "after" },
        );
        res.json({ success: true, lesson: result });
      } catch {
        res.status(500).json({ message: "Server error" });
      }
    });

    // DELETE /lessons/:id — owner or admin
    app.delete("/lessons/:id", verifyToken, async (req, res) => {
      try {
        const lesson = await lessonsCollection.findOne({
          _id: new ObjectId(req.params.id),
        });
        if (!lesson) return res.status(404).json({ message: "Not found" });

        const isOwner = lesson.userId === req.user._id.toString();
        const isAdmin = req.user.role === "admin";

        if (!isOwner && !isAdmin) {
          return res.status(403).json({ message: "Forbidden" });
        }

        await lessonsCollection.deleteOne({ _id: new ObjectId(req.params.id) });
        res.json({ success: true });
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

    // ── ADMIN ROUTES

    // GET /admin/users — all users with lesson count
    app.get("/admin/users", verifyToken, verifyAdmin, async (req, res) => {
      try {
        const users = await usersCollection.find({}).toArray();
        // each user  lesson count
        const usersWithCount = await Promise.all(
          users.map(async (u) => {
            const count = await lessonsCollection.countDocuments({
              userId: u._id.toString(),
            });
            return { ...u, lessonCount: count };
          }),
        );
        res.json(usersWithCount);
      } catch {
        res.status(500).json({ message: "Server error" });
      }
    });

    // PATCH /admin/users/:id/role
    app.patch(
      "/admin/users/:id/role",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const { role } = req.body;
          if (!["user", "admin"].includes(role))
            return res.status(400).json({ message: "Invalid role" });
          await usersCollection.updateOne(
            { _id: new ObjectId(req.params.id) },
            { $set: { role, updatedAt: new Date() } },
          );
          res.json({ success: true });
        } catch {
          res.status(500).json({ message: "Server error" });
        }
      },
    );

    // PATCH /admin/users/:id/suspend
    app.patch(
      "/admin/users/:id/suspend",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const { suspended } = req.body;
          await usersCollection.updateOne(
            { _id: new ObjectId(req.params.id) },
            { $set: { suspended, updatedAt: new Date() } },
          );
          res.json({ success: true });
        } catch {
          res.status(500).json({ message: "Server error" });
        }
      },
    );

    // DELETE /admin/users/:id
    app.delete(
      "/admin/users/:id",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        try {
          await usersCollection.deleteOne({ _id: new ObjectId(req.params.id) });
          await lessonsCollection.deleteMany({ userId: req.params.id });
          res.json({ success: true });
        } catch {
          res.status(500).json({ message: "Server error" });
        }
      },
    );

    // GET /admin/lessons — all lessons + report count
    app.get("/admin/lessons", verifyToken, verifyAdmin, async (req, res) => {
      try {
        const { category, accessLevel, isPublic, search } = req.query;
        const query = {};
        if (category) query.category = category;
        if (accessLevel) query.accessLevel = accessLevel;
        if (isPublic !== undefined) query.isPublic = isPublic === "true";
        if (search) {
          query.$or = [
            { title: { $regex: search, $options: "i" } },
            { userName: { $regex: search, $options: "i" } },
          ];
        }

        const lessons = await lessonsCollection
          .find(query)
          .sort({ createdAt: -1 })
          .toArray();

        // each lesson report count
        const withReports = await Promise.all(
          lessons.map(async (l) => {
            const id = l._id.toString();
            const reportCount = await reportsCollection.countDocuments({
              lessonId: id,
            });
            return { ...l, reportCount };
          }),
        );
        res.json(withReports);
      } catch {
        res.status(500).json({ message: "Server error" });
      }
    });

    // PATCH /admin/lessons/:id/feature
    app.patch(
      "/admin/lessons/:id/feature",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const { featured } = req.body;
          await lessonsCollection.updateOne(
            { _id: new ObjectId(req.params.id) },
            { $set: { featured, updatedAt: new Date() } },
          );
          res.json({ success: true });
        } catch {
          res.status(500).json({ message: "Server error" });
        }
      },
    );

    // PATCH /admin/lessons/:id/reviewed
    app.patch(
      "/admin/lessons/:id/reviewed",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        try {
          await lessonsCollection.updateOne(
            { _id: new ObjectId(req.params.id) },
            { $set: { reviewed: true, reviewedAt: new Date() } },
          );
          res.json({ success: true });
        } catch {
          res.status(500).json({ message: "Server error" });
        }
      },
    );

    // DELETE /admin/lessons/:id
    app.delete(
      "/admin/lessons/:id",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        try {
          await lessonsCollection.deleteOne({
            _id: new ObjectId(req.params.id),
          });
          // related reports ও clear
          await reportsCollection.deleteMany({ lessonId: req.params.id });
          res.json({ success: true });
        } catch {
          res.status(500).json({ message: "Server error" });
        }
      },
    );

    // GET /admin/reports — all reports grouped by lessonId
    app.get("/admin/reports", verifyToken, verifyAdmin, async (req, res) => {
      try {
        const reports = await reportsCollection
          .find({})
          .sort({ createdAt: -1 })
          .toArray();

        // group by lessonId
        const grouped = {};
        for (const r of reports) {
          if (!grouped[r.lessonId]) grouped[r.lessonId] = [];
          grouped[r.lessonId].push(r);
        }

        // lesson info
        const result = await Promise.all(
          Object.entries(grouped).map(async ([lessonId, reps]) => {
            let lesson = null;
            try {
              lesson = await lessonsCollection.findOne({
                _id: new ObjectId(lessonId),
              });
            } catch {}
            return {
              lessonId,
              lessonTitle: lesson?.title || "Deleted Lesson",
              lessonAuthor: lesson?.userName || "Unknown",
              reportCount: reps.length,
              reports: reps,
              resolved: reps.every((r) => r.resolved),
            };
          }),
        );

        // unresolved
        result.sort((a, b) => (a.resolved ? 1 : -1));
        res.json(result);
      } catch {
        res.status(500).json({ message: "Server error" });
      }
    });

    // PATCH /admin/reports/resolve/:lessonId — clear all reports for a lesson
    app.patch(
      "/admin/reports/resolve/:lessonId",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        try {
          await reportsCollection.updateMany(
            { lessonId: req.params.lessonId },
            { $set: { resolved: true, resolvedAt: new Date() } },
          );
          res.json({ success: true });
        } catch {
          res.status(500).json({ message: "Server error" });
        }
      },
    );

    // GET /admin/stats — dashboard analytics
    app.get("/admin/stats", verifyToken, verifyAdmin, async (req, res) => {
      try {
        const now = new Date();
        const today = new Date(
          now.getFullYear(),
          now.getMonth(),
          now.getDate(),
        );

        const [
          totalUsers,
          totalLessons,
          publicLessons,
          privateLessons,
          reportedLessons,
          todayLessons,
        ] = await Promise.all([
          usersCollection.countDocuments({}),
          lessonsCollection.countDocuments({}),
          lessonsCollection.countDocuments({ isPublic: true }),
          lessonsCollection.countDocuments({ isPublic: false }),
          reportsCollection.distinct("lessonId"),
          lessonsCollection.countDocuments({ createdAt: { $gte: today } }),
        ]);

        // top contributors (most lessons)
        const topContributors = await lessonsCollection
          .aggregate([
            {
              $group: {
                _id: "$userId",
                count: { $sum: 1 },
                userName: { $first: "$userName" },
                userAvatar: { $first: "$userAvatar" },
              },
            },
            { $sort: { count: -1 } },
            { $limit: 5 },
          ])
          .toArray();

        // last 7 days lesson counts
        const weeklyData = await Promise.all(
          Array.from({ length: 7 }, (_, i) => {
            const d = new Date(today);
            d.setDate(d.getDate() - (6 - i));
            const next = new Date(d);
            next.setDate(next.getDate() + 1);
            return lessonsCollection.countDocuments({
              createdAt: { $gte: d, $lt: next },
            });
          }),
        );

        res.json({
          totalUsers,
          totalLessons,
          publicLessons,
          privateLessons,
          reportedCount: reportedLessons.length,
          todayLessons,
          topContributors,
          weeklyData,
        });
      } catch {
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
