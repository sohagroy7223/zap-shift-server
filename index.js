const express = require("express");
const cors = require("cors");
const app = express();
const { MongoClient, ObjectId } = require("mongodb");
require("dotenv").config();

const port = process.env.PORT || 3000;

const crypto = require("crypto");
const { initializeApp, cert } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { count } = require("console");

const serviceAccount = {
  type: process.env.FIREBASE_TYPE,
  project_id: process.env.FIREBASE_PROJECT_ID,
  private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
  private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  client_id: process.env.FIREBASE_CLIENT_ID,
  auth_uri: process.env.FIREBASE_AUTH_URI,
  token_uri: process.env.FIREBASE_TOKEN_URI,
  auth_provider_x509_cert_url: process.env.FIREBASE_AUTH_PROVIDER_X509_CERT_URL,
  client_x509_cert_url: process.env.FIREBASE_CLIENT_X509_CERT_URL,
  universe_domain: process.env.FIREBASE_UNIVERSE_DOMAIN,
};

initializeApp({
  credential: cert(serviceAccount),
});

const generateTrackingId = () => {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");

  const randomPart = crypto.randomBytes(4).toString("hex").toUpperCase();

  return `ZPS-${date}-${randomPart}`;
};

const stripe = require("stripe")(process.env.STRIPE_SECRETE);

// middleWare
app.use(express.json());
app.use(cors());

const verifyFirebaseToken = async (req, res, next) => {
  const authorization = req.headers.authorization;
  if (!authorization) {
    return res.status(401).send({ message: "unauthorized access" });
  }

  const token = authorization.split(" ")[1];
  if (!token) {
    return res.status(401).send({ message: "unauthorized access" });
  }

  // verify Id token
  try {
    const decoded = await getAuth().verifyIdToken(token);
    // console.log("after decoded ", decoded);

    req.tokenEmail = decoded.email;
  } catch (error) {
    return res.status(401).send({ message: "unauthorized access" });
  }

  next();
};

const client = new MongoClient(
  `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@crud-practice-cluster.l3ixzxm.mongodb.net/?appName=crud-practice-cluster&compressors=zlib`,
);

async function connectToMongoDB() {
  try {
    await client.connect();
    const zapDB = client.db("zap_shift_db");
    const userCollection = zapDB.collection("users");
    const parcelCollection = zapDB.collection("parcels");
    const paymentCollection = zapDB.collection("payments");
    const ridersCollection = zapDB.collection("riders");
    const trackingsCollection = zapDB.collection("trackings");

    // middleware more with database access
    const verifyAdmin = async (req, res, next) => {
      const email = req.tokenEmail;
      const query = { email };
      const user = await userCollection.findOne(query);
      if (!user || user.role !== "admin") {
        return res.status(403).send({ message: "forbidden access" });
      }
      next();
    };

    const logTracking = async (trackingId, status) => {
      const log = {
        trackingId,
        status,
        details: status.split("-").join(" "),
        createdAt: new Date(),
      };
      const result = await trackingsCollection.insertOne(log);
    };

    // user related apis
    app.post("/users", async (req, res) => {
      const user = req.body;
      user.role = "user";
      user.createdAt = new Date();
      const email = user.email;

      const userExist = await userCollection.findOne({ email });
      if (userExist) {
        return res.send({ message: "this user already has login" });
      }

      const result = await userCollection.insertOne(user);
      res.send(result);
    });

    app.get("/users", verifyFirebaseToken, async (req, res) => {
      const search = req.query.search;
      const query = {};
      if (search) {
        // query.displayName = { $regex: search, $options: "i" };
        query.$or = [
          { displayName: { $regex: search, $options: "i" } },
          { email: { $regex: search, $options: "i" } },
        ];
      }
      const cursor = userCollection
        .find(query)
        .limit(10)
        .sort({ createdAt: -1 });
      const result = await cursor.toArray();
      res.send(result);
    });

    app.get("/users/:email/role", async (req, res) => {
      const email = req.params.email;
      const query = { email };
      const user = await userCollection.findOne(query);
      res.send({ role: user?.role });
    });

    app.patch(
      "/users/:id/role",
      verifyFirebaseToken,
      verifyAdmin,
      async (req, res) => {
        const id = req.params.id;
        const query = { _id: new ObjectId(id) };
        const roleInfo = req.body;
        const updatedDoc = {
          $set: {
            role: roleInfo.role,
          },
        };
        const result = await userCollection.updateOne(query, updatedDoc);
        res.send(result);
      },
    );

    // riders relayed apis
    app.post("/riders", async (req, res) => {
      const rider = req.body;
      const email = rider.email;
      rider.status = "pending";
      rider.createdAt = new Date();
      const existUser = await ridersCollection.findOne({ email });
      if (existUser) {
        return res.send({ message: "this riders already exist" });
      }
      const result = await ridersCollection.insertOne(rider);
      res.send(result);
    });

    app.get("/riders/delivery-per-day", async (req, res) => {
      const email = req.query.email;

      const pipeline = [
        // 1. Get this rider's delivered parcels
        {
          $match: {
            riderEmail: email,
            deliveryStatus: "parcel-delivered",
          },
        },

        // 2. Get tracking information
        {
          $lookup: {
            from: "trackings",
            localField: "trackingId",
            foreignField: "trackingId",
            as: "parcel_tracking",
          },
        },

        // 3. Remove the parcel_tracking array
        {
          $unwind: "$parcel_tracking",
        },

        // 4. Count parcels by day
        {
          $group: {
            _id: {
              $dateToString: {
                format: "%Y-%m-%d",
                date: "$parcel_tracking.createdAt",
              },
            },
            parcelDelivered: {
              $sum: 1,
            },
          },
        },

        // 5. Make the response easy to use
        {
          $project: {
            _id: 0,
            date: "$_id",
            parcelDelivered: 1,
          },
        },
      ];

      const result = await parcelCollection.aggregate(pipeline).toArray();

      res.send(result);
    });

    app.get("/riders", async (req, res) => {
      const { status, district, workStatus } = req.query;
      const query = {};
      if (status) {
        query.status = status;
      }
      if (district) {
        query.district = district;
      }
      if (workStatus) {
        query.workStatus = workStatus;
      }
      const cursor = ridersCollection.find(query).sort({ createdAt: -1 });
      const result = await cursor.toArray();
      res.send(result);
    });

    app.patch("/riders/:id", verifyFirebaseToken, async (req, res) => {
      const status = req.body.status;
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const update = {
        $set: {
          status: status,
          workStatus: "available",
        },
      };
      const result = await ridersCollection.updateOne(query, update);
      if (status === "approved") {
        const email = req.body.email;
        const query = { email };
        const updateUser = {
          $set: {
            role: "rider",
          },
        };
        const userResult = await userCollection.updateOne(query, updateUser);
        // res.send(userResult);
      }
      res.send(result);
    });

    app.delete("/riders/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await ridersCollection.deleteOne(query);
      res.send(result);
    });

    // payments related apis

    app.get("/parcels", async (req, res) => {
      const query = {};
      const { email, deliveryStatus } = req.query;
      if (email) {
        query.senderEmail = email;
      }

      if (deliveryStatus) {
        query.deliveryStatus = deliveryStatus;
      }

      const options = { sort: { createdAt: -1 } };

      const cursor = parcelCollection.find(query, options);
      const result = await cursor.toArray();
      res.send(result);
    });

    app.get("/parcels/delivery-status/status", async (req, res) => {
      const pipeline = [
        {
          $group: {
            _id: "$deliveryStatus",
            count: { $sum: 1 },
          },
        },
        {
          $project: {
            status: "$_id",
            count: 1,
            _id: 0,
          },
        },
      ];
      const result = await parcelCollection.aggregate(pipeline).toArray();
      res.send(result);
    });

    app.post("/parcels", async (req, res) => {
      const parcel = req.body;
      const trackingId = generateTrackingId();
      parcel.createdAt = new Date();
      parcel.trackingId = trackingId;
      const result = await parcelCollection.insertOne(parcel);
      res.send(result);
    });

    app.get("/parcels/rider", async (req, res) => {
      const { riderEmail, deliveryStatus } = req.query;
      const query = {};
      if (riderEmail) {
        query.riderEmail = riderEmail;
      }
      if (deliveryStatus !== "parcel-delivered") {
        query.deliveryStatus = { $in: ["delivery_assign", "rider-arriving"] };
        query.deliveryStatus = { $nin: ["parcel-delivered"] };
      } else {
        query.deliveryStatus = deliveryStatus;
      }
      const cursor = parcelCollection.find(query);
      const result = await cursor.toArray();
      res.send(result);
    });

    app.get("/parcels/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await parcelCollection.findOne(query);
      res.send(result);
    });

    app.patch("/parcels/:id", async (req, res) => {
      const { riderId, riderName, riderEmail, trackingId } = req.body;
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const parcelsUpdateDoc = {
        $set: {
          deliveryStatus: "driver-assigned",
          riderId: riderId,
          riderName: riderName,
          riderEmail: riderEmail,
        },
      };
      const result = await parcelCollection.updateOne(query, parcelsUpdateDoc);

      // rider update
      const riderQuery = { _id: new ObjectId(riderId) };
      const riderUpdateDoc = {
        $set: {
          workStatus: "in_delivery",
        },
      };
      const riderResult = await ridersCollection.updateOne(
        riderQuery,
        riderUpdateDoc,
      );

      // log Tracking
      logTracking(trackingId, "driver-assigned");

      res.send(riderResult, result);
    });

    app.patch("/parcels/:id/status", async (req, res) => {
      const { deliveryStatus, riderId, trackingId } = req.body;
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const updatedDoc = {
        $set: {
          deliveryStatus: deliveryStatus,
        },
      };

      if (deliveryStatus === "parcel-delivered") {
        const riderQuery = { _id: new ObjectId(riderId) };
        const riderUpdateDoc = {
          $set: {
            workStatus: "available",
          },
        };
        const riderResult = await ridersCollection.updateOne(
          riderQuery,
          riderUpdateDoc,
        );
      }

      const result = await parcelCollection.updateOne(query, updatedDoc);

      // log tracking
      logTracking(trackingId, deliveryStatus);
      res.send(result);
    });

    app.patch("/parcels/:id/reject", async (req, res) => {
      const id = req.params.id;
      const parcelQuery = { _id: new ObjectId(id) };
      const parcel = await parcelCollection.findOne(parcelQuery);
      const riderId = parcel.riderId;

      // parcel update
      const parcelUpdateDoc = {
        $set: {
          deliveryStatus: "parcel-paid",
        },
        $unset: {
          riderEmail: "",
          riderId: "",
          riderName: "",
        },
      };
      const parcelResult = await parcelCollection.updateOne(
        parcelQuery,
        parcelUpdateDoc,
      );

      // update rider

      const rider = { _id: new ObjectId(riderId) };
      const riderQuery = await ridersCollection.findOne(rider);
      const updateRIderDoc = {
        $set: {
          workStatus: "available",
        },
      };
      const result = await ridersCollection.updateOne(
        riderQuery,
        updateRIderDoc,
      );
      res.send(parcelResult, result);
    });

    app.delete("/parcels/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await parcelCollection.deleteOne(query);
      res.send(result);
    });

    app.post("/payment-checkout-section", async (req, res) => {
      const paymentInfo = req.body;

      const amount = parseInt(paymentInfo.cost) * 100;
      const section = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: "usd",
              unit_amount: amount,
              product_data: {
                name: paymentInfo.parcelName,
              },
            },
            quantity: 1,
          },
        ],
        mode: "payment",
        metadata: {
          parcelId: paymentInfo.parcelId,
          parcelName: paymentInfo.parcelName,
          trackingId: paymentInfo.trackingId,
        },
        customer_email: paymentInfo.senderEmail,
        success_url: `${process.env.SIDE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.SIDE_DOMAIN}/dashboard/payment-cancel`,
      });
      // console.log(section);
      res.send({ url: section.url });
    });

    // old payment section**
    // app.post("/create-checkout-session", async (req, res) => {
    //   const paymentInfo = req.body;

    //   const amount = parseInt(paymentInfo.cost) * 100;

    //   const session = await stripe.checkout.sessions.create({
    //     line_items: [
    //       {
    //         price_data: {
    //           currency: "USD",
    //           unit_amount: amount,
    //           product_data: {
    //             name: paymentInfo.parcelName,
    //           },
    //         },
    //         quantity: 1,
    //       },
    //     ],
    //     customer_email: paymentInfo.senderEmail,
    //     mode: "payment",
    //     success_url: `${process.env.SIDE_DOMAIN}/dashboard/payment-success`,
    //     cancel_url: `${process.env.SIDE_DOMAIN}/dashboard/payment-cancel`,
    //   });
    //   console.log(session);
    //   res.send({ url: session.url });
    // });

    app.patch("/payment-success", async (req, res) => {
      const sessionId = req.query.session_id;

      const session = await stripe.checkout.sessions.retrieve(sessionId);

      // use the previous tracking Id
      const trackingId = session.metadata.trackingId;

      if (session.payment_status !== "paid") {
        return res.send({
          success: false,
        });
      }

      const paymentExist = await paymentCollection.findOne({
        transactionId: session.payment_intent,
      });

      if (paymentExist) {
        return res.send({
          message: "this payment already exist",
          transactionId: paymentExist.transactionId,
        });
      }

      if (session.payment_status === "paid") {
        const id = session.metadata.parcelId;
        const query = { _id: new ObjectId(id) };
        const update = {
          $set: {
            paymentStatus: "paid",
            deliveryStatus: "parcel-paid",
            trackingId: trackingId,
          },
        };

        const result = await parcelCollection.updateOne(query, update);

        const payment = {
          amount: session.amount_total / 100,
          currency: session.currency,
          customerEmail: session.customer_email,
          parcelId: session.metadata.parcelId,
          parcelName: session.metadata.parcelName,
          transactionId: session.payment_intent,
          paymentStatus: session.payment_status,
          paidAt: new Date(),
          trackingId: trackingId,
        };

        if (session.payment_status === "paid") {
          const resultPayment = await paymentCollection.insertOne(payment);

          logTracking(trackingId, "parcel-paid");

          res.send({
            success: true,
            modifyParcel: result,
            trackingId: trackingId,
            transactionId: session.payment_intent,
            paymentInfo: resultPayment,
          });
        }
      }

      // res.send({ success: false });
    });

    // payments related apis
    app.get("/payments", verifyFirebaseToken, async (req, res) => {
      const email = req.query.email;
      const query = {};
      if (email) {
        query.customerEmail = email;
        // check the email
        if (email !== req.tokenEmail) {
          res.status(403).send({ message: "forbidden access" });
        }
      }
      const cursor = paymentCollection.find(query).sort({ createdAt: -1 });
      const result = await cursor.toArray();
      res.send(result);
    });

    // tracking related apis
    app.get("/trackings/:trackingId/logs", async (req, res) => {
      const trackingId = req.params.trackingId;
      const query = { trackingId };
      const result = await trackingsCollection.find(query).toArray();
      res.send(result);
    });

    app.all(/.*/, (req, res) => {
      res.status(404).json({
        status: 404,
        error: "API not found",
      });
    });

    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (err) {
    console.dir(err);
  }
}
connectToMongoDB();

app.get("/", (req, res) => {
  res.send("zap ship is running");
});

app.listen(port, () => {
  console.log(`zap-ship-server app listening on port ${port}`);
});
