const express = require("express");
var cors = require("cors");
const app = express();
require("dotenv").config();
const port = process.env.PORT || 3000;

// meddleWare
app.use(express.json());
app.use(cors());

app.get("/", (req, res) => {
  res.send("zap ship is running");
});

app.listen(port, () => {
  console.log(`zap-ship-server app listening on port ${port}`);
});
