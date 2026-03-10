import express from 'express';
const app = express();
import path from 'path';
import cors from 'cors';
const port = process.env.PORT || 3001;

app.use(express.json({ limit: '50mb' }));
app.use(express.static('build'));
app.use(cors());
import { dirname } from "path";
import { fileURLToPath } from "url";
import mongoose from 'mongoose';

const _dirname = dirname(fileURLToPath(import.meta.url));
app.get("/", (req, res) => {
    res.sendFile(path.join(_dirname, "index.html"))
})

function isRetryableMongoNetworkError(err) {
    const name = err?.name || '';
    const msg = String(err?.message || '');
    return (
        name === 'MongoNetworkError' ||
        name === 'MongoServerSelectionError' ||
        msg.toLowerCase().includes('connection') ||
        msg.toLowerCase().includes('socket') ||
        msg.toLowerCase().includes('timed out') ||
        (err?.errorLabels && (err.errorLabels.has?.('ResetPool') || err.errorLabels.has?.('RetryableWriteError')))
    );
}

async function sleep(ms) {
    await new Promise(r => setTimeout(r, ms));
}

async function connectWithRetry(uri, attempts = 3) {
    const options = {
        serverSelectionTimeoutMS: 30000,
        connectTimeoutMS: 30000,
        socketTimeoutMS: 0,
        maxPoolSize: 10,
        minPoolSize: 0,
        retryReads: true,
        retryWrites: true,
        heartbeatFrequencyMS: 10000,
    };

    let lastErr;
    for (let i = 0; i < attempts; i++) {
        try {
            const conn = mongoose.createConnection(uri, options);
            await conn.asPromise();
            return conn;
        } catch (e) {
            lastErr = e;
            const backoff = Math.min(1000 * (2 ** i), 8000);
            await sleep(backoff);
        }
    }
    throw lastErr;
}

async function copyCollectionInBatches({ sourceDb, destDb, collectionName, batchSize = 1000 }) {
    const sourceCol = sourceDb.collection(collectionName);
    const destCol = destDb.collection(collectionName);

    await destCol.deleteMany({});

    const cursor = sourceCol.find({}, { batchSize });
    let batch = [];
    let processed = 0;

    for await (const doc of cursor) {
        batch.push(doc);
        if (batch.length >= batchSize) {
            const ops = batch.map(d => ({
                replaceOne: { filter: { _id: d._id }, replacement: d, upsert: true }
            }));
            await destCol.bulkWrite(ops, { ordered: false });
            processed += batch.length;
            batch = [];
        }
    }

    if (batch.length) {
        const ops = batch.map(d => ({
            replaceOne: { filter: { _id: d._id }, replacement: d, upsert: true }
        }));
        await destCol.bulkWrite(ops, { ordered: false });
        processed += batch.length;
    }

    return processed;
}

app.post("/syncDb", async (req, res) => {
    let { connectionString1, connectionString2, dbToCopy } = req.body;
    connectionString1 = `${connectionString1}/${dbToCopy}?authSource=admin`;
    connectionString2 = `${connectionString2}/${dbToCopy}?authSource=admin`;

    if (!connectionString1.startsWith('mongodb') || !connectionString2.startsWith('mongodb')) {
        return res.status(400).json({ error: "Invalid Strings" });
    }
    try {
        let connection1;
        let connection2;
        try {
            connection1 = await connectWithRetry(connectionString1);
            connection2 = await connectWithRetry(connectionString2);

            const collections = (await connection1.db.listCollections().toArray()).map(i => i.name);
            console.log("Collections:", collections);

            const results = [];
            for (const name of collections) {
                let lastErr;
                for (let attempt = 1; attempt <= 3; attempt++) {
                    try {
                        console.log(`Copying ${name} (attempt ${attempt})...`);
                        const copied = await copyCollectionInBatches({
                            sourceDb: connection1.db,
                            destDb: connection2.db,
                            collectionName: name,
                            batchSize: 1000
                        });
                        console.log(`Copied ${name}: ${copied} docs`);
                        results.push({ collection: name, copied });
                        lastErr = undefined;
                        break;
                    } catch (e) {
                        lastErr = e;
                        console.error(`Error copying ${name} (attempt ${attempt}):`, e?.message || e);
                        if (!isRetryableMongoNetworkError(e) || attempt === 3) break;
                        await sleep(Math.min(1000 * (2 ** (attempt - 1)), 8000));
                    }
                }
                if (lastErr) throw lastErr;
            }

            console.log("Success");
            return res.json({ message: "Success", results });
        } finally {
            await connection1?.close().catch(() => { });
            await connection2?.close().catch(() => { });
        }
    } catch (error) {
        console.error("Error during database synchronization:", error);
        res.status(500).json({
            error: "Database synchronization failed",
            details: error?.message || String(error)
        });
    }
});


app.listen(port, async () => {
    console.log("Server Started at PORT", port)
})




