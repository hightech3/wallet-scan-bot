import bs58 from "bs58";
import {
  Keypair,
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  VersionedTransaction,
  TransactionMessage,
} from "@solana/web3.js";
import axios from "axios";
import { TokenModel } from "./token.js";
import { TOKEN_PROGRAM_ID, getMint } from "@solana/spl-token";
import { Token, SPL_ACCOUNT_LAYOUT } from "@raydium-io/raydium-sdk";

import mongoose from "mongoose";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import input from "input";
import {
  apiId,
  apiHash,
  rpc,
  pk,
  buy_amount,
  jitofee,
  sl_rate,
  tp_level,
  tp_percentages,
} from "./config.js";
import { isInValidKeyPair } from "@solana-common/utils";
import { channels } from "./channels.js";

const dbURI = "mongodb://127.0.0.1:27017/signalbot";
const stringSession = new StringSession("");
const connection = new Connection(rpc);
const keypair = Keypair.fromSecretKey(bs58.decode(pk));

(async () => {
  try {
    await mongoose.connect(dbURI);
    console.log("MongoDB connected");
  } catch (error) {
    console.error("MongoDB connection error:", error);
    process.exit(1);
  }
  console.log("Loading interactive example...");
  // Initialize Telegram client
  const client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 5,
  });
  // Start Telegram client interaction with input prompts
  await client.start({
    phoneNumber: async () => await input.text("Please enter your number: "),
    password: async () => await input.text("Please enter your password: "),
    phoneCode: async () =>
      await input.text("Please enter the code you received: "),
    onError: (err) => console.log(err),
  });
  console.log("You should now be connected.");

  // const targetChannelId = "+neYb6dqvpXdmOTJl";
  // Event handler for incoming messages
  client.addEventHandler(async (event) => {
    if (event.message) {
      const state = event?.message?.peerId?.channelId?.value;
      if(channels.includes(state)) {
        const result = parseMessage(event.message);
        if (result == null) return;
        if (result.signal == "buy") {
            buy(result.token);
        } else if (result.signal == "sell") {
            sell(result.token);
        }
      }
    }
  });
  // Start monitoring stop-loss
  sl_monitor();
})();

// Sleep utility function for delaying execution
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Parse message from Telegram and determine buy or sell signal
const parseMessage = (message) => {
  try {
    let token = getSubstringBetween(
      message.message,
      "CA: ",
      "\n🤴 Price"
    );
    if (token != null) {
      let buyTokenName = getSubstringBetween(message.message,"☘️ ", "($");
      console.log('🆕 Token to buy :>> "', buyTokenName, '" , Address :>> ', token);
      return { token, signal: "buy" };
    } else {
      if (message.message.includes("🔥🔥🔥")) {
        token = message.media.webpage.url.substring(
          message.media.webpage.url.lastIndexOf("_") + 1
        );
        let selTokenName = getSubstringBetween(message.message,"🔥🔥🔥", "| $");
        console.log('🆕 Token to sell :>> "', selTokenName, '" , Address :>> ', token);
        return { token, signal: "sell" };
      }
    }
  } catch (error) {
    return null;
  }
};

// Get substring between two strings
function getSubstringBetween(str, start, end) {
  const startIndex = str.indexOf(start);
  const endIndex = str.indexOf(end, startIndex + start.length);
  if (startIndex !== -1 && endIndex !== -1) {
    return str.substring(startIndex + start.length, endIndex);
  }
  return null;
}

// Function for buying a token
const buy = async (token) => {
  // Get quote for swapping SOL to the specific token
  const quoteResponse = await (
    await fetch(
      `https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${token}&amount=${buy_amount * LAMPORTS_PER_SOL
      }&slippageBps=5000`
    )
  ).json();
  // Swap SOL for the token
  const { swapTransaction } = await (
    await fetch("https://quote-api.jup.ag/v6/swap", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        quoteResponse,
        userPublicKey: keypair.publicKey.toString(),
        wrapAndUnwrapSol: true,
      }),
    })
  ).json();
  const swapTransactionBuf = Buffer.from(swapTransaction, "base64");
  var transaction = VersionedTransaction.deserialize(swapTransactionBuf);
  transaction.sign([keypair]);
  const txSignature = bs58.encode(transaction.signatures[0]);
  const latestBlockHash = await connection.getLatestBlockhash("processed");

  // Send transaction bundle
  let result = await sendBundle(
    transaction,
    keypair,
    latestBlockHash,
    jitofee * LAMPORTS_PER_SOL
  );
  if (result) {
    console.log("🟢 Buy Success. \n🔗 http://solscan.io/tx/" + txSignature);
    const t = new TokenModel({ address: token, current_tp_level: tp_level, initialTokenBalance: quoteResponse.outAmount });
    t.save();
  } else {
    console.log("🔴 Buy failed because of network problem");
  }
};

// Function for selling a token
const sell = async (token) => {
  const t = await TokenModel.findOne({ address: token });
  if (t == null) return;

  // Get balance of the token
  let tokenBalance = await getTokenBalance(keypair.publicKey, token, true);

  console.log("💸 TokenBalance :>> ", tokenBalance);

  tokenBalance = tokenBalance * tp_percentages[tp_level - t.current_tp_level]/100.0;

  // Get quote for swapping the token back to SOL
  const quoteResponse = await (
    await fetch(
      `https://quote-api.jup.ag/v6/quote?inputMint=${token}&outputMint=So11111111111111111111111111111111111111112&amount=${tokenBalance}&slippageBps=5000`
    )
  ).json();

  // Perform swap transaction
  const { swapTransaction } = await (
    await fetch("https://quote-api.jup.ag/v6/swap", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        quoteResponse,
        userPublicKey: keypair.publicKey.toString(),
        wrapAndUnwrapSol: true,
      }),
    })
  ).json();
  const swapTransactionBuf = Buffer.from(swapTransaction, "base64");
  var transaction = VersionedTransaction.deserialize(swapTransactionBuf);
  transaction.sign([keypair]);
  const txSignature = bs58.encode(transaction.signatures[0]);
  const latestBlockHash = await connection.getLatestBlockhash("processed");

  // Send transaction bundle
  let result = await sendBundle(transaction, keypair, latestBlockHash, jitofee);
  if (result) {
    console.log(`⭐ TP${tp_level-t.current_tp_level+1} Hit, ${tp_percentages[tp_level - t.current_tp_level]}% Selling...`);
    console.log("🟢 Sell Success. \n🔗 http://solscan.io/tx/" + txSignature);
    if(t.current_tp_level == 1) {
        TokenModel.findOneAndDelete({ address: token });
    } else {
        TokenModel.updateOne({address: token}, {current_tp_level: t.current_tp_level - 1})
    }
  } else {
    console.log("🔴 Sell failed because of network problem");
  }
};

// Monitor tokens for potential stop-loss situations
const sl_monitor = async () => {
  while (true) {
    const tokens = await TokenModel.find({});
    for (let i = 0; i < tokens.length; i++) {
      let tokenBalance = await getTokenBalance(
        keypair.publicKey,
        tokens[i].address,
        true
      );
      // console.log("SL monitor, tokenBalance = ", tokenBalance);
      if (tokenBalance == 0) {
        console.log('💸 Not enough balance :>>', tokens[i].address);
        continue;
      }
      
      // Get quote for swapping the token back to SOL
      let quoteResponse = await (
        await fetch(
          `https://quote-api.jup.ag/v6/quote?inputMint=${tokens[i].address}&outputMint=So11111111111111111111111111111111111111112&amount=${tokens[i].initialTokenBalance}&slippageBps=5000`
        )
      ).json();

      // If current price is below stop-loss level, perform a sell
      if (
        Number(quoteResponse.outAmount) >
        (tokens[i].current_tp_level < 4 ? buy_amount : buy_amount * sl_rate) * LAMPORTS_PER_SOL
      )
        continue;
      (async () => {
        quoteResponse = await (
            await fetch(
              `https://quote-api.jup.ag/v6/quote?inputMint=${tokens[i].address}&outputMint=So11111111111111111111111111111111111111112&amount=${tokenBalance}&slippageBps=5000`
            )
        ).json();
        // Swap token back to SOL in case of stop-loss
        const { swapTransaction } = await (
          await fetch("https://quote-api.jup.ag/v6/swap", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              quoteResponse,
              userPublicKey: keypair.publicKey.toString(),
              wrapAndUnwrapSol: true,
            }),
          })
        ).json();
        const swapTransactionBuf = Buffer.from(swapTransaction, "base64");
        var transaction = VersionedTransaction.deserialize(swapTransactionBuf);
        transaction.sign([keypair]);
        const txSignature = bs58.encode(transaction.signatures[0]);
        const latestBlockHash = await connection.getLatestBlockhash(
          "processed"
        );
        let result = await sendBundle(
          transaction,
          keypair,
          latestBlockHash,
          jitofee
        );
        if (result) {
          console.log("🟡 SL Sell. \n🔗 http://solscan.io/tx/" + txSignature);
          TokenModel.findOneAndDelete({ address: tokens[i] });
        }
      })();
      await sleep(1000);
    }
  }
};

// An asynchronous function to get the wallet's token accounts
export const getWalletTokenAccount = async (connection, wallet) => {
  // Fetch token accounts owned by the wallet using the connection object and specify TOKEN_PROGRAM_ID
  const walletTokenAccount = await connection.getTokenAccountsByOwner(wallet, {
    programId: TOKEN_PROGRAM_ID,
  });
  // Map over the token account values and decode account information
  return walletTokenAccount.value.map((i) => ({
    pubkey: i.pubkey,
    programId: i.account.owner,
    accountInfo: SPL_ACCOUNT_LAYOUT.decode(i.account.data),
  }));
};

// An asynchronous function to get the token balance of a specific token address in the wallet
export const getTokenBalance = async (wallet, tokenAddress, lamports) => {
  const mint = new PublicKey(tokenAddress);
  const mintInfo = await getMint(connection, mint);
  // Create a Token object with its decimals
  const baseToken = new Token(
    TOKEN_PROGRAM_ID,
    tokenAddress,
    mintInfo.decimals
  );
  // Get the wallet's token accounts
  const walletTokenAccounts = await getWalletTokenAccount(connection, wallet);
  let tokenBalance = 0;
  if (walletTokenAccounts && walletTokenAccounts.length > 0) {
    // Loop through all token accounts of the wallet
    for (let walletTokenAccount of walletTokenAccounts) {
      // Check if the token account belongs to the required mint address
      if (walletTokenAccount.accountInfo.mint.toBase58() === tokenAddress) {
        // If lamports is true, use raw amount; otherwise, convert according to decimals
        if (lamports == true)
          tokenBalance = Number(walletTokenAccount.accountInfo.amount);
        else
          tokenBalance =
            Number(walletTokenAccount.accountInfo.amount) /
            10 ** baseToken.decimals;
        break;
      }
    }
  }
  return tokenBalance;
};

// List of Jito Validators' public keys
const jito_Validators = [
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
];

// Function to get a random validator from the list
async function getRandomValidator() {
  const res =
    jito_Validators[Math.floor(Math.random() * jito_Validators.length)];
  return new PublicKey(res);
}

// An asynchronous function to send a bundle transaction to a Jito Validator
export async function sendBundle(transaction, payer, lastestBlockhash, jitofee) {
    const jito_validator_wallet = await getRandomValidator(); // Get a random Jito Validator
    try {
      if (isInValidKeyPair(payer)) return; // Validate payer keypair
  
      // Construct a Jito fee message for transaction
      const jitoFee_message = new TransactionMessage({
        payerKey: payer.publicKey,
        recentBlockhash: lastestBlockhash.blockhash,
        instructions: [
          SystemProgram.transfer({
            fromPubkey: payer.publicKey,
            toPubkey: jito_validator_wallet,
            lamports: jitofee, // Specify the lamports for transfer
          }),
        ],
      }).compileToV0Message();
  
      // Create a Versioned Transaction with the Jito Fee message
      const jitoFee_transaction = new VersionedTransaction(jitoFee_message);
      jitoFee_transaction.sign([payer]); // Sign the transaction with the payer
  
      // Serialize Jito Fee transaction and normal transaction
      const serializedJitoFeeTransaction = bs58.encode(jitoFee_transaction.serialize());
      const serializedTransaction = bs58.encode(transaction.serialize());
  
      // Prepare final transaction bundle
      const final_transaction = [serializedJitoFeeTransaction, serializedTransaction];
  
      console.log("Sending bundles...");
  
      // Send the transaction bundle to Jito endpoint
      const { data } = await axios.post(
        "https://amsterdam.mainnet.block-engine.jito.wtf/api/v1/bundles",
        {
          jsonrpc: "2.0",
          id: 1,
          method: "sendBundle",
          params: [final_transaction],
        }
      );
  
      let bundleIds = [];
      if (data) {
        console.log(data);
        bundleIds = [data.result]; // Store bundle ID result
      }
  
      console.log("Checking bundle's status...", bundleIds);
      const sentTime = Date.now();
      let confirmed = false;
  
      // Poll to check the bundle's status for up to 1 minutes
      while (Date.now() - sentTime < 60000) {
        try {
          const { data } = await axios.post(
            `https://amsterdam.mainnet.block-engine.jito.wtf/api/v1/bundles`,
            {
              jsonrpc: "2.0",
              id: 1,
              method: "getBundleStatuses",
              params: [bundleIds],
            },
            {
              headers: {
                "Content-Type": "application/json",
              },
            }
          );
  
          if (data) {
            const bundleStatuses = data.result.value;
            console.log(`Bundle Statuses (${(Date.now() - sentTime)/1000}s):`, bundleStatuses);
            let success = true;
  
            // Check each bundle ID's confirmation status
            for (let i = 0; i < bundleIds.length; i++) {
              const matched = bundleStatuses.find((item) => item && item.bundle_id === bundleIds[i]);
              if (!matched || matched.confirmation_status !== "confirmed") {
                success = false; // Mark as failure if not confirmed
                break;
              }
            }
  
            // Set confirmed flag if successfully confirmed
            if (success) {
              confirmed = true;
              break;
            }
          }
        } catch (err) {
          console.log("❌ JITO ERROR:", err);
          break;
        }
        await sleep(1000); // Sleep for 1 second before retrying
      }
      return confirmed; // Return confirmation status
    } catch (e) {
      // Error handling based on the type of error
      if (e instanceof axios.AxiosError) {
        console.log("❌ Failed to execute the jito transaction");
      } else {
        console.log("❌ Error during jito transaction execution: ", e);
      }
      return false; // Return false on error
    }
  }