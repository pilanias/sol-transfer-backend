import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import {
  Connection,
  clusterApiUrl,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL
} from '@solana/web3.js';
import bip39 from 'bip39';
import { derivePath } from 'ed25519-hd-key';
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createTransferInstruction
} from '@solana/spl-token';

const app = express();
const port = process.env.PORT || 3005;

app.use(cors());
app.use(bodyParser.json());

let transactionLog = [];
let monitoringTasks = {};

const confirmTransactionWithRetries = async (connection, signature, retries = 3, timeout = 60000) => {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const confirmation = await connection.confirmTransaction(signature, 'confirmed', { timeout });
      return confirmation;
    } catch (error) {
      if (attempt === retries - 1) {
        throw error;
      }
      console.log(`Retrying transaction confirmation, attempt ${attempt + 1}...`);
    }
  }
};

app.post('/start-monitoring', async (req, res) => {
  const { seed, secureWalletPublicKey, network, tokenMintAddress } = req.body;
  const seedPhrase = seed.join(' '); // Convert array of words to a phrase

  try {
    // Derive seed and key pair using BIP44 path
    const seedBuffer = await bip39.mnemonicToSeed(seedPhrase);
    const derivedSeed = derivePath("m/44'/501'/0'/0'", seedBuffer.toString('hex')).key;
    const compromisedWallet = Keypair.fromSeed(derivedSeed);

    const newSecureWalletPublicKey = new PublicKey(secureWalletPublicKey);
    const connection = new Connection(clusterApiUrl(network), 'confirmed');

    console.log(`Monitoring for incoming transactions on ${network} for address ${compromisedWallet.publicKey.toBase58()}`);

    const handleAccountChange = async (accountInfo) => {
      const lamports = accountInfo.lamports;
      if (lamports > 0) {
        console.log(`Received ${lamports / LAMPORTS_PER_SOL} SOL, transferring to secure wallet...`);

        const transactionFee = 5000; // Estimate transaction fee in lamports
        const lamportsToTransfer = lamports - transactionFee;
        
        if (lamportsToTransfer <= 0) {
          console.error('Not enough SOL to cover the transaction fee.');
          return;
        }

        const transaction = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: compromisedWallet.publicKey,
            toPubkey: newSecureWalletPublicKey,
            lamports: lamportsToTransfer
          })
        );

        try {
          const signature = await connection.sendTransaction(transaction, [compromisedWallet]);
          console.log('Transfer transaction sent with signature:', signature);

          const confirmation = await confirmTransactionWithRetries(connection, signature);
          console.log('Transfer transaction confirmed:', confirmation);

          transactionLog.push({
            signature,
            from: compromisedWallet.publicKey.toBase58(),
            to: newSecureWalletPublicKey.toBase58(),
            amount: lamportsToTransfer / LAMPORTS_PER_SOL,
            status: 'confirmed',
          });
        } catch (error) {
          console.error('Error transferring funds:', error);
          if (error instanceof SendTransactionError) {
            console.error('Transaction Logs:', error.transactionLogs);
          }
        }
      }
    };

    const handleTokenAccountChange = async (accountInfo) => {
      const tokenAmount = accountInfo.amount;
      if (tokenAmount > 0) {
        console.log(`Received ${tokenAmount} tokens, transferring to secure wallet...`);

        const associatedTokenAccount = await getAssociatedTokenAddress(
          new PublicKey(tokenMintAddress),
          newSecureWalletPublicKey
        );

        const transaction = new Transaction().add(
          createAssociatedTokenAccountInstruction(
            compromisedWallet.publicKey,
            associatedTokenAccount,
            newSecureWalletPublicKey,
            new PublicKey(tokenMintAddress)
          ),
          createTransferInstruction(
            accountInfo.address,
            associatedTokenAccount,
            compromisedWallet.publicKey,
            tokenAmount,
            [],
            TOKEN_PROGRAM_ID
          )
        );

        try {
          const signature = await connection.sendTransaction(transaction, [compromisedWallet]);
          console.log('Transfer transaction sent with signature:', signature);

          const confirmation = await confirmTransactionWithRetries(connection, signature);
          console.log('Transfer transaction confirmed:', confirmation);

          transactionLog.push({
            signature,
            from: compromisedWallet.publicKey.toBase58(),
            to: newSecureWalletPublicKey.toBase58(),
            amount: tokenAmount,
            status: 'confirmed',
          });
        } catch (error) {
          console.error('Error transferring tokens:', error);
          if (error instanceof SendTransactionError) {
            console.error('Transaction Logs:', error.transactionLogs);
          }
        }
      }
    };

    const subscriptionId = tokenMintAddress
      ? connection.onTokenAccountChange(compromisedWallet.publicKey, handleTokenAccountChange)
      : connection.onAccountChange(compromisedWallet.publicKey, handleAccountChange);

    monitoringTasks[compromisedWallet.publicKey.toBase58()] = {
      connection,
      subscriptionId,
      handleAccountChange,
      handleTokenAccountChange,
      tokenMintAddress,
    };

    res.json({ message: 'Monitoring started', publicKey: compromisedWallet.publicKey.toBase58() });
  } catch (error) {
    console.error('Error deriving key pair:', error);
    res.status(500).json({ message: 'Error deriving key pair', error: error.message });
  }
});

app.post('/stop-monitoring', (req, res) => {
  const { publicKey } = req.body;

  if (monitoringTasks[publicKey]) {
    const { connection, subscriptionId, tokenMintAddress } = monitoringTasks[publicKey];

    if (tokenMintAddress) {
      connection.removeProgramAccountChangeListener(subscriptionId);
    } else {
      connection.removeAccountChangeListener(subscriptionId);
    }

    delete monitoringTasks[publicKey];
    res.json({ message: 'Monitoring stopped' });
    console.log({message: `Monitoring stopped for ${publicKey}`});
  } else {
    res.status(400).json({ message: 'Monitoring not found for this public key' });
  }
});

app.get('/transactions', (req, res) => {
  res.json(transactionLog);
});

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
