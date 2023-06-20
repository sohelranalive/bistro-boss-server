const express = require('express');
const cors = require('cors');
const nodemailer = require("nodemailer");
const mg = require('nodemailer-mailgun-transport');
require('dotenv').config()
const stripe = require('stripe')(process.env.PAYMENT_SECRET_KEY);
const jwt = require('jsonwebtoken');

const app = express()
const port = process.env.PORT || 5000

//middleware
app.use(cors())
app.use(express.json())


//send mail

// let transporter = nodemailer.createTransport({
//     host: 'smtp.sendgrid.net',
//     port: 587,
//     auth: {
//         user: "apikey",
//         pass: process.env.SENDGRID_API_KEY
//     }
// })

const auth = {
    auth: {
        api_key: process.env.EMAIL_KEY,
        domain: process.env.EMAIL_DOMAIN
    }
}

const transporter = nodemailer.createTransport(mg(auth));


const sendPaymentConfirmationEmail = payment => {
    transporter.sendMail({
        from: 'sohel.cse37@gmail.com', // verified sender email
        to: 'sohel.cse37@gmail.com', // recipient email
        subject: "Payment Confirmation", // Subject line
        text: "Payment Confirmed", // plain text body
        html: `
        <h3>You payment successful</h3>
        <p>Enjoy the order, more details coming soon.</p>
        `, // html body
    }, function (error, info) {
        if (error) {
            console.log(error);
        } else {
            console.log('Email sent: ' + info.response);
        }
    });
}


const verifyJWT = (req, res, next) => {
    const authorization = req.headers.authorization;
    if (!authorization) {
        return res.status(401).send({ error: true, message: 'unauthorized access' })
    }
    const token = authorization.split(' ')[1]
    jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, (err, decoded) => {
        if (err) {
            return res.status(401).send({ error: true, message: 'unauthorized access' })
        }
        req.decoded = decoded;
        next()
    })
}


const { MongoClient, ServerApiVersion, Collection, ObjectId } = require('mongodb');
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.3krokas.mongodb.net/?retryWrites=true&w=majority`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

async function run() {
    try {
        // Connect the client to the server	(optional starting in v4.7)
        //await client.connect();

        const userCollection = client.db('bistroDB').collection('user');
        const menuCollection = client.db('bistroDB').collection('menu');
        const reviewCollection = client.db('bistroDB').collection('reviews');
        const cartCollection = client.db('bistroDB').collection('cart');
        const paymentCollection = client.db('bistroDB').collection('payment');

        //user related apis

        /*
            secure allUsers route
            1. Don't show the route who should not see it
            2. verifyJWT
            3. verifyAdmin

      */

        const verifyAdmin = async (req, res, next) => {
            const email = req.decoded.email
            const query = { email: email }
            const user = await userCollection.findOne(query)
            if (user?.role !== 'admin') {
                return res.status(403).send({ error: true, message: 'forbidden access' })
            }
            next()
        }


        app.get('/users', verifyJWT, verifyAdmin, async (req, res) => {
            const result = await userCollection.find().toArray()
            res.send(result)
        })

        app.post('/users', async (req, res) => {
            const userInfo = req.body
            const query = { email: userInfo.email }
            const existingUser = await userCollection.findOne(query)

            if (existingUser) {
                return res.send({ message: 'User already exist' })
            }

            const result = await userCollection.insertOne(userInfo)
            res.send(result)
        })

        app.get('/users/admin/:email', verifyJWT, async (req, res) => {
            const email = req.params.email;

            if (req.decoded.email !== email) {
                return res.send({ admin: false })
            }

            const query = { email: email }
            const user = await userCollection.findOne(query)
            const result = { admin: user?.role === 'admin' }
            res.send(result);
        })


        app.patch('/users/admin/:id', async (req, res) => {
            const id = req.params.id;
            const filter = { _id: new ObjectId(id) }
            const updateDoc = {
                $set: {
                    role: 'admin'
                },
            };
            const result = await userCollection.updateOne(filter, updateDoc);
            res.send(result);
        })


        //create a payment intent
        app.post('/create-payment-intent', verifyJWT, async (req, res) => {
            const { price } = req.body;
            // console.log(price);
            const amount = price * 100;
            const paymentIntent = await stripe.paymentIntents.create({
                amount: amount,
                currency: 'usd',
                payment_method_types: ['card']
            });

            res.send({
                clientSecret: paymentIntent.client_secret
            })
        })

        //payment related API

        app.post('/payments', verifyJWT, async (req, res) => {
            const payment = req.body;
            const insertResult = await paymentCollection.insertOne(payment);

            sendPaymentConfirmationEmail()

            const query = { _id: { $in: payment.cartItems.map(id => new ObjectId(id)) } }
            const deleteResult = await cartCollection.deleteMany(query)

            res.send({ insertResult, deleteResult });
        })

        app.get('/admin-stats', verifyJWT, verifyAdmin, async (req, res) => {
            const customers = await userCollection.estimatedDocumentCount();
            const menu = await menuCollection.estimatedDocumentCount();
            const orders = await paymentCollection.estimatedDocumentCount();

            const totalOrder = await paymentCollection.find().toArray();
            const revenue = totalOrder.reduce((sum, count) => sum + count.price, 0)

            res.send({
                customers, menu, orders, revenue
            })

        })

        app.get('/order-stats', verifyJWT, verifyAdmin, async (req, res) => {
            const pipeline = [
                {
                    $lookup: {
                        from: 'menu',
                        localField: 'menuItems',
                        foreignField: '_id',
                        as: 'menuItemsData'
                    }
                },
                {
                    $unwind: '$menuItemsData'
                },
                {
                    $group: {
                        _id: '$menuItemsData.category',
                        count: { $sum: 1 },
                        total: { $sum: '$menuItemsData.price' }
                    }
                },
                {
                    $project: {
                        category: '$_id',
                        count: 1,
                        total: { $round: ['$total', 2] },
                        _id: 0
                    }
                }
            ];

            const result = await paymentCollection.aggregate(pipeline).toArray()
            res.send(result)

        })


        //jwt apis
        app.post('/jwt', (req, res) => {
            const user = req.body;
            const token = jwt.sign(user, process.env.ACCESS_TOKEN_SECRET, { expiresIn: '1hr' })
            res.send({ token })
        })


        //menu related apis
        app.get('/menu', async (req, res) => {
            const result = await menuCollection.find().toArray()
            res.send(result)
        })

        app.post('/menu', verifyJWT, verifyAdmin, async (req, res) => {
            const newItem = req.body
            const result = await menuCollection.insertOne(newItem)
            res.send(result)
        })

        app.delete('/menu/:id', verifyJWT, verifyAdmin, async (req, res) => {
            const id = req.params.id;
            const query = { _id: new ObjectId(id) }
            const result = await menuCollection.deleteOne(query)
            res.send(result)
        })

        //review related apis
        app.get('/reviews', async (req, res) => {
            const result = await reviewCollection.find().toArray()
            res.send(result)
        })

        //cart related apis
        app.post('/cart', async (req, res) => {
            const item = req.body;
            const result = await cartCollection.insertOne(item);
            res.send(result)
        })

        app.get('/carts', verifyJWT, async (req, res) => {
            const qEmail = req.query.email;
            if (!qEmail) {
                return res.send([])
            }

            const decodedEmail = req.decoded.email;

            if (qEmail !== decodedEmail) {
                return res.status(403).send({ error: true, message: 'Forbidden Access' })
            }

            const query = { email: qEmail }
            const result = await cartCollection.find(query).toArray();
            res.send(result)
        })

        app.delete('/carts/:id', async (req, res) => {
            const id = req.params.id;
            const query = { _id: new ObjectId(id) }
            const result = await cartCollection.deleteOne(query)
            res.send(result)
        })


        // Send a ping to confirm a successful connection
        await client.db("admin").command({ ping: 1 });
        console.log("Pinged your deployment. You successfully connected to MongoDB!");
    } finally {
        // Ensures that the client will close when you finish/error
        // await client.close();
    }
}
run().catch(console.dir);




app.get('/', (req, res) => {
    res.send('Bistro Boss Server is running')
})

app.listen(port, () => {
    console.log(`Bistro Boss Server Is Running on: ${port}`);
})
