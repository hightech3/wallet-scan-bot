import mongoose from "mongoose";

const tokenSchema = new mongoose.Schema({
  address: { type: String },
  current_tp_level: { type: Number },
  initialTokenBalance: { type: Number },
  // sells: { type: Number, default: 0 },
});

export const TokenModel = mongoose.model("TokenModel", tokenSchema);