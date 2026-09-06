const express = require("express");
const cors = require("cors");
const app = express();
const { MongoClient, ObjectId } = require("mongodb");
require("dotenv").config();

const port = process.env.PORT || 3000;

const crypto = require("crypto");

const generateTrackingId = () => {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");

  const randomPart = crypto.randomBytes(4).toString("hex").toUpperCase();

  return `ZPS-${date}-${randomPart}`;
};

const stripe = require("stripe")(process.env.STRIPE_SECRETE);

// meddleWare
app.use(express.json());
app.use(cors());

const client = new MongoClient(
  `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@crud-practice-cluster.l3ixzxm.mongodb.net/?appName=crud-practice-cluster&compressors=zlib`,
);

async function connectToMongoDB() {
  try {
    await client.connect();
    const zapDB = client.db("zap_shift_db");
    const parcelCollection = zapDB.collection("parcels");
    const paymentCollection = zapDB.collection("payments");

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
      console.log(section);
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
