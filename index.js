const express = require("express");
const cors = require("cors");
const app = express();
const { MongoClient, ObjectId } = require("mongodb");
require("dotenv").config();

const port = process.env.PORT || 3000;

const crypto = require("crypto");
const { initializeApp, cert } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");

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

    // riders relayed apis
    app.post("/riders", async (req, res) => {
      const rider = req.body;
      const email = rider.email;
      rider.role = "rider";
      rider.status = "pending";
      rider.createdAt = new Date();
      const existUser = await ridersCollection.findOne({ email });
      if (existUser) {
        return res.send({ message: "this riders already exist" });
      }
      const result = await ridersCollection.insertOne(rider);
      res.send(result);
    });

    // payments related apis

    app.get("/parcels", async (req, res) => {
      const query = {};
      const { email } = req.query;
      if (email) {
        query.senderEmail = email;
      }

      const options = { sort: { createdAt: -1 } };

      const cursor = parcelCollection.find(query, options);
      const result = await cursor.toArray();
      res.send(result);
    });

    app.post("/parcels", async (req, res) => {
      const parcel = req.body;
      const result = await parcelCollection.insertOne(parcel);
      res.send(result);
    });

    app.get("/parcels/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await parcelCollection.findOne(query);
      res.send(result);
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
        },
        customer_email: paymentInfo.senderEmail,
        success_url: `${process.env.SIDE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.SIDE_DOMAIN}/dashboard/payment-cancel`,
      });
      // console.log(section);
      res.send({ url: section.url });
    });

    // old payment section

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
      const trackingId = generateTrackingId();

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
          trackingId: paymentExist.trackingId,
        });
      }

      if (session.payment_status === "paid") {
        const id = session.metadata.parcelId;
        const query = { _id: new ObjectId(id) };
        const update = {
          $set: {
            paymentStatus: "paid",
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
