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

app.post("/syncDb", async (req, res) => {
    let { connectionString1, connectionString2, dbToCopy } = req.body;
    connectionString1 = `${connectionString1}/${dbToCopy}`;
    connectionString2 = `${connectionString2}/${dbToCopy}`;

    if (!connectionString1.startsWith('mongodb') || !connectionString2.startsWith('mongodb')) return res.send({ error: "Invalid Strings" })
    try {
        const connection1 = await mongoose.createConnection(connectionString1);
        await new Promise((resolve) => {
            connection1.on('open', () => {
                resolve();
            });
        });

        const collections = (await connection1.db.listCollections().toArray()).map(i => i.name);
        console.log(collections)

        let dataToCopy = {};

        for (let i of collections) {
            dataToCopy[i] = (await connection1.db.collection(i).find().toArray()).map(item => {
                item._id = item._id.toString();
                return item
            });

        }
        
        for (let i in dataToCopy) {
            if (dataToCopy[i].length == 0) delete dataToCopy[i]
        }
        console.log(dataToCopy)

        await connection1.close();

        const connection2 = await mongoose.createConnection(connectionString2);
        await new Promise((resolve) => {
            connection2.on('open', () => {
                resolve();
            });
        });
        for (let i of collections) {
            let temp = await connection2.db.collection(i).deleteMany({});
        }
        console.log("Deletion Successful")
        for (let i in dataToCopy) {
            let temp = await connection2.db.collection(i).insertMany(dataToCopy[i]);
            console.log(temp)
        }
        return res.send({ message: "Success" })
    } catch (error) {
        console.error("Error during database synchronization:", error);
        res.status(500).send("Internal Server Error");
    }
});


app.listen(port, async () => {
    console.log("Server Started at PORT", port)
})




