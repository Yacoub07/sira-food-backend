require('dotenv').config();
const express = require('express');
const { PrismaClient } = require('@prisma/client');
const cors = require('cors');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());
const prisma = new PrismaClient();

const PORT = process.env.PORT || 3000;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

// 🧠 CMS CONFIG
function getBotConfig() {
    try { return JSON.parse(fs.readFileSync('./bot-config.json', 'utf8')); } 
    catch (e) { return null; }
}

// 📱 FONCTIONS WHATSAPP
async function sendWhatsAppMessage(toPhone, text) {
    await fetch(`https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages`, { method: 'POST', headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ messaging_product: "whatsapp", to: toPhone, type: "text", text: { body: text } }) });
}
async function sendWhatsAppButtons(toPhone, textBody, buttonsArray) {
    const formattedButtons = buttonsArray.map(btn => ({ type: "reply", reply: { id: btn.id.substring(0,20), title: btn.title.substring(0,20) } }));
    await fetch(`https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages`, { method: 'POST', headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ messaging_product: "whatsapp", to: toPhone, type: "interactive", interactive: { type: "button", body: { text: textBody }, action: { buttons: formattedButtons } } }) });
}
async function sendWhatsAppList(toPhone, textTitle, rows) {
    const safeRows = rows.map(r => ({ ...r, title: r.title.substring(0,24) }));
    await fetch(`https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages`, { method: 'POST', headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ messaging_product: "whatsapp", to: toPhone, type: "interactive", interactive: { type: "list", header: { type: "text", text: "SIRA SERVICES" }, body: { text: textTitle }, footer: { text: "Faites votre choix" }, action: { button: "Ouvrir le Menu 📋", sections:[{ title: "Options", rows: safeRows }] } } }) });
}

// 💻 API DASHBOARD REACT
app.get('/api/orders', async (req, res) => {
    const orders = await prisma.order.findMany({ where: { status: { not: 'DRAFT' } }, include: { user: true, driver: true, business: true, items: { include: { product: true } } }, orderBy: { createdAt: 'desc' } });
    const formattedOrders = orders.map(o => ({ ...o, serviceName: o.serviceName || o.items.map(i => `${i.quantity}x ${i.product.name}`).join(' + '), quantity: 1 }));
    res.json(formattedOrders);
});

// 🚀 OPTION A : LE DISPATCH AUX LIVREURS
app.put('/api/orders/:id/dispatch', async (req, res) => {
    const order = await prisma.order.update({ where: { id: req.params.id }, data: { status: 'ACCEPTED' }, include: { user: true, business: true } });
    
    // 1. On prévient le client
    await sendWhatsAppMessage(order.user.phone, `✅ Votre commande est validée ! Nous cherchons un livreur/chauffeur...`);
    
    // 2. 🛵 MAGIE : ON ALERTE TOUS LES LIVREURS DISPONIBLES SUR WHATSAPP !
    const drivers = await prisma.driver.findMany({ where: { isAvailable: true } });
    for (const driver of drivers) {
        const msgLivreur = `🚨 *NOUVELLE COURSE SIRA*\n\n📦 Service: ${order.serviceName || "Livraison"}\n💰 Montant: ${order.totalAmount} FCFA\n\nAppuyez sur le bouton ci-dessous pour accepter la course :`;
        await sendWhatsAppButtons(driver.phone, msgLivreur,[
            { id: `drv_acc_${order.id}`, title: "✅ Accepter Course" }
        ]);
    }
    res.json(order);
});

// 🚀 OPTION C : LA FIDÉLITÉ (SIRA REWARDS) À LA LIVRAISON
app.put('/api/orders/:id/complete', async (req, res) => { 
    const order = await prisma.order.update({ where: { id: req.params.id }, data: { status: 'COMPLETED' }, include: { user: true } });
    
    // Calcul des points (Ex: 100 FCFA = 1 Point)
    const pointsGagnes = Math.floor(order.totalAmount / 100);
    const newPointsTotal = order.user.loyaltyPoints + pointsGagnes;
    
    await prisma.user.update({ where: { id: order.user.id }, data: { loyaltyPoints: newPointsTotal } });
    
    await sendWhatsAppMessage(order.user.phone, `🎉 *Mission Terminée !*\n\n🎁 Vous avez gagné *${pointsGagnes} points Sira Rewards* !\nVotre solde est de : *${newPointsTotal} points*.\n\nMerci d'avoir utilisé SIRA !`);
    res.json({ success: true }); 
});

app.delete('/api/orders/:id', async (req, res) => { await prisma.order.delete({ where: { id: req.params.id } }); res.json({ success: true }); });
app.get('/api/businesses', async (req, res) => { res.json(await prisma.business.findMany({ orderBy: { type: 'asc' } })); });
app.post('/api/businesses', async (req, res) => { res.json(await prisma.business.create({ data: req.body })); });
app.get('/api/products', async (req, res) => { res.json(await prisma.product.findMany({ include: { business: true } })); });
app.post('/api/products', async (req, res) => { res.json(await prisma.product.create({ data: { ...req.body, price: parseFloat(req.body.price) } })); });
app.get('/api/drivers', async (req, res) => { res.json(await prisma.driver.findMany()); });
app.post('/api/drivers', async (req, res) => { res.json(await prisma.driver.create({ data: req.body })); });

// 💳 OPTION B : PAIEMENT MALI (Orange Money / SamaPay Webhook)
app.post('/mali-pay-notify', async (req, res) => {
    // C'est ici que SamaPay ou TouchPay enverra la confirmation du paiement
    const transaction_id = req.body.transaction_id || req.body.cpm_trans_id;
    if (transaction_id) {
        const order = await prisma.order.update({ where: { id: transaction_id }, data: { status: "PAID", paymentMethod: "MOBILE_MONEY" }, include: { user: true } });
        await sendWhatsAppMessage(order.user.phone, `🎉 *PAIEMENT ORANGE/MOOV REÇU !*\n\nNous avons reçu vos *${order.totalAmount} FCFA*. Traitement immédiat !`);
    }
    res.send('OK');
});

// ========================================================================
// 🧠 WEBHOOK WHATSAPP (CLIENTS & LIVREURS)
// ========================================================================
app.get('/webhook', (req, res) => res.status(200).send(req.query['hub.challenge']));

app.post('/webhook', async (req, res) => {
    res.status(200).send('EVENT_RECEIVED'); 
    try {
        const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
        if (!message) return;

        const senderPhone = message.from; 
        const contactName = req.body.entry?.[0]?.changes?.[0]?.value?.contacts?.[0]?.profile?.name || "Client"; 
        
        let user = await prisma.user.findUnique({ where: { phone: senderPhone } });
        if (!user) user = await prisma.user.create({ data: { phone: senderPhone, name: contactName, botState: "IDLE", tempData: {} } });

        // Vérifier si c'est un livreur qui écrit
        let driver = await prisma.driver.findUnique({ where: { phone: senderPhone } });

        const config = getBotConfig();

        // 🛡️ CONDITIONS D'UTILISATION (Pour les clients)
        if (!user.hasAcceptedTC) {
            if (message.type === 'interactive' && message.interactive.button_reply.id === 'tc_accept') {
                user = await prisma.user.update({ where: { id: user.id }, data: { hasAcceptedTC: true } });
                await sendWhatsAppMessage(senderPhone, "✅ Merci d'avoir accepté nos conditions. Bienvenue chez Sira !");
                message.type = 'text'; message.text = { body: 'menu' }; 
            } else if (message.type === 'interactive' && message.interactive.button_reply.id === 'tc_refuse') {
                await sendWhatsAppMessage(senderPhone, "❌ Vous devez accepter les conditions pour utiliser Sira Services.");
                return;
            } else {
                const termsText = config?.terms_and_conditions || `👋 Bienvenue sur *Sira Services* !\n\n📌 Vos informations sont enregistrées pour traiter vos commandes.\n✅ Acceptez-vous nos conditions ?`;
                await sendWhatsAppButtons(senderPhone, termsText,[ { id: "tc_accept", title: "1️⃣ Oui, j'accepte" }, { id: "tc_refuse", title: "2️⃣ Non, je refuse" } ]);
                return; 
            }
        }

        const text = message.type === 'text' ? message.text.body.toLowerCase() : "";

        // 🎁 OPTION C : VOIR SES POINTS DE FIDÉLITÉ
        if (text === "points" || text === "fidelite" || text === "cadeau") {
            await sendWhatsAppMessage(senderPhone, `🎁 *Sira Rewards*\n\n👤 Nom : ${user.name}\n⭐ Solde : *${user.loyaltyPoints} points*\n\n*(À partir de 1000 points, vous aurez droit à une course gratuite !)*`);
            return;
        }

        // 🛑 ANNULATION
        if (["annuler", "menu", "retour", "bonsoir", "hi", "hello", "ok", "salut", "bonjour"].includes(text)) {
            await prisma.user.update({ where: { id: user.id }, data: { botState: "IDLE", tempData: {} } });
            user.botState = "IDLE";
        }
        
        // 💳 SIMULATION PAIEMENT MALI
        if (text === "payé" || text === "paye") {
            const orderToPay = await prisma.order.findFirst({ where: { userId: user.id, status: "PENDING" }, orderBy: { createdAt: 'desc' } });
            if (orderToPay) await fetch(`http://localhost:${PORT}/mali-pay-notify`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ transaction_id: orderToPay.id }) });
            return;
        }

        // ========================================================================
        // 🛵 ACTIONS DU LIVREUR (L'APPLICATION DANS WHATSAPP)
        // ========================================================================
        if (message.type === 'interactive' && driver) {
            const actionId = message.interactive.button_reply?.id;
            
            // Le livreur clique sur "Accepter Course"
            if (actionId && actionId.startsWith("drv_acc_")) {
                const orderId = actionId.replace("drv_acc_", "");
                const order = await prisma.order.findUnique({ where: { id: orderId }, include: { user: true } });

                // On vérifie si un autre livreur ne l'a pas déjà prise !
                if (order && order.status === "ACCEPTED") {
                    // On lui assigne la course
                    await prisma.order.update({ where: { id: orderId }, data: { status: "ASSIGNED", driverId: driver.id } });
                    
                    // On donne le GPS au livreur
                    const gpsClient = order.latitude ? `https://maps.google.com/?q=${order.latitude},${order.longitude}` : "Non spécifié";
                    await sendWhatsAppButtons(senderPhone, `✅ *COURSE ACCEPTÉE !*\n\n👤 Client: ${order.user.name}\n📞 Tel: ${order.user.phone}\n📍 GPS: ${gpsClient}\n💰 À encaisser: ${order.totalAmount} FCFA\n\nQuand vous avez terminé, cliquez ci-dessous :`,[
                        { id: `drv_fin_${order.id}`, title: "🏁 Terminer la course" }
                    ]);

                    // On prévient le client
                    await sendWhatsAppMessage(order.user.phone, `🛵 *Votre chauffeur est en route !*\n\n👤 Nom: ${driver.name}\n📞 Tel: ${driver.phone}\nPréparez-vous !`);
                } else {
                    await sendWhatsAppMessage(senderPhone, `❌ Trop tard ! Cette course a déjà été prise par un collègue ou a été annulée.`);
                }
                return;
            }

            // Le livreur clique sur "Terminer la course"
            if (actionId && actionId.startsWith("drv_fin_")) {
                const orderId = actionId.replace("drv_fin_", "");
                // On utilise notre propre route pour déclencher les points de fidélité !
                await fetch(`http://localhost:${PORT}/api/orders/${orderId}/complete`, { method: 'PUT' });
                await sendWhatsAppMessage(senderPhone, `✅ Bien joué ! Course terminée et enregistrée. En attente de la prochaine mission...`);
                return;
            }
        }// ========================================================================
        // 🧠 MACHINE À ÉTATS TEXTUELS (CLIENTS)
        // ========================================================================
        if (user.botState === "MARKET_CUSTOM_LIST" && message.type === 'text') {
            let biz = await prisma.business.findFirst({ where: { type: "MARKET" } });
            await prisma.order.create({ data: { userId: user.id, businessId: biz?.id, status: "PENDING", totalAmount: 0, serviceName: `Courses Demandées: ${message.text.body}` } });
            await prisma.user.update({ where: { id: user.id }, data: { botState: "MARKET_AWAITING_GPS", tempData: {} } });
            await sendWhatsAppMessage(senderPhone, `✅ *Liste enregistrée !*\n\n📍 Veuillez envoyer votre *Position GPS* (📎 -> Localisation) pour la livraison.`);
            return;
        }

        if (user.botState === "TAXI_STEP_1_DEST" && message.type === 'text') {
            const typeTrans = user.tempData?.type || "Taxi";
            await prisma.user.update({ where: { id: user.id }, data: { botState: "TAXI_STEP_2_PASS", tempData: { ...user.tempData, destination: message.text.body } } });
            if (typeTrans === "Coursier") await sendWhatsAppMessage(senderPhone, `📍 Destination colis : *${message.text.body}*\n\n📦 Que souhaitez-vous faire livrer ?`);
            else await sendWhatsAppMessage(senderPhone, `📍 Destination : *${message.text.body}*\n\n👥 Combien de passagers êtes-vous ?`);
            return;
        }
        if (user.botState === "TAXI_STEP_2_PASS" && message.type === 'text') {
            await prisma.user.update({ where: { id: user.id }, data: { botState: "TAXI_AWAITING_GPS", tempData: { ...user.tempData, passagers: message.text.body } } });
            await sendWhatsAppMessage(senderPhone, `📍 Veuillez envoyer votre *Position Actuelle* via WhatsApp (📎 -> Localisation).`);
            return;
        }

        if (user.botState === "BUS_STEP_1_DEST" && message.type === 'text') {
            await prisma.user.update({ where: { id: user.id }, data: { botState: "BUS_STEP_2_DATE", tempData: { destination: message.text.body } } });
            await sendWhatsAppMessage(senderPhone, `📍 Ville de destination : *${message.text.body}*\n\n📅 Pour quelle date ?`);
            return;
        }
        if (user.botState === "BUS_STEP_2_DATE" && message.type === 'text') {
            const dest = user.tempData?.destination;
            const price = config?.bus_pricing || 8000;
            let biz = await prisma.business.findFirst({ where: { type: "TRANSPORT" } });
            await prisma.order.create({ data: { userId: user.id, businessId: biz?.id, status: "PENDING", totalAmount: price, serviceName: `Billet Bus -> ${dest} (${message.text.body})` } });
            await prisma.user.update({ where: { id: user.id }, data: { botState: "IDLE", tempData: {} } });
            await sendWhatsAppMessage(senderPhone, `🎟️ *Réservation Validée*\n\n📍 Dest: ${dest}\n📅 Date: ${message.text.body}\n💰 Prix: ${price} FCFA\n💳 Tapez "payé" pour régler.`);
            return;
        }

        if (user.botState === "IDLE") {
            if (message.type === 'text' &&["menu", "salut", "bonjour", "bonsoir", "hi", "hello", "ok"].includes(text)) {
                const welcomeMsg = config?.welcome_message || `🌟 *Menu Principal SIRA*`;
                const listRows = config?.menu_options ||[
                    { id: "flow_FOOD", title: "🍔 Commander à manger" }, { id: "flow_MARKET", title: "🛒 Sira Market" },
                    { id: "flow_TAXI", title: "🚕 Transport & Logistique" }, { id: "flow_BUS", title: "🚌 Voyage Interurbain" }, { id: "flow_IMMO", title: "🏠 Agence Immobilière" }
                ];
                await sendWhatsAppList(senderPhone, welcomeMsg, listRows);
            }

            else if (message.type === 'interactive') {
                const actionId = message.interactive.list_reply?.id || message.interactive.button_reply?.id;
                
                // Si c'est une action Livreur (déjà gérée plus haut), on ignore ici
                if (actionId.startsWith("drv_")) return;

                if (actionId === "flow_TAXI") {
                    await sendWhatsAppButtons(senderPhone, `🚕 *Transport & Logistique*\nQuel type de service souhaitez-vous ?`,[
                        { id: "taxi_moto", title: "🏍️ Moto Taxi" }, { id: "taxi_car", title: "🚕 Taxi Auto" }, { id: "taxi_delivery", title: "📦 Coursier/Livreur" }
                    ]);
                }
                else if (["taxi_moto", "taxi_car", "taxi_delivery"].includes(actionId)) {
                    const typeTrans = actionId === "taxi_moto" ? "Moto Taxi" : actionId === "taxi_car" ? "Taxi" : "Coursier";
                    await prisma.user.update({ where: { id: user.id }, data: { botState: "TAXI_STEP_1_DEST", tempData: { type: typeTrans } } });
                    await sendWhatsAppMessage(senderPhone, `Service : *${typeTrans}*\n\n📍 Quelle est votre destination (ou lieu de livraison) ?`);
                }
                else if (actionId === "flow_IMMO") {
                    await sendWhatsAppButtons(senderPhone, `🏠 *Sira Immobilier*\nQue recherchez-vous ?`,[{ id: "immo_rent", title: "1️⃣ Location" }, { id: "immo_buy", title: "2️⃣ Achat" }]);
                }
                else if (actionId === "immo_rent" || actionId === "immo_buy") {
                    const typeText = actionId === "immo_rent" ? "Location" : "Achat";
                    await prisma.user.update({ where: { id: user.id }, data: { botState: "IMMO_STEP_2_BUDGET", tempData: { type: typeText } } });
                    await sendWhatsAppMessage(senderPhone, `🏡 Service : *${typeText}*\n\n💰 Quel est votre budget maximum en FCFA ?`);
                }
                else if (actionId === "flow_MARKET") {
                    const listRows =[
                        { id: "market_boutique", title: "🛍️ Boutiques & Mode" }, { id: "market_supermarket", title: "🛒 Supermarchés" },
                        { id: "market_hardware", title: "🔨 Matériaux & Quinc." }, { id: "market_custom", title: "📝 Faire une liste", description: "Courses sur mesure" }
                    ];
                    await sendWhatsAppList(senderPhone, `🛒 *SIRA MARKET*\nDans quel rayon souhaitez-vous aller ?`, listRows);
                }
                else if (actionId === "market_custom") {
                    await prisma.user.update({ where: { id: user.id }, data: { botState: "MARKET_CUSTOM_LIST" } });
                    await sendWhatsAppMessage(senderPhone, `📝 *Courses sur mesure*\n\nÉcrivez la liste de tout ce que vous cherchez. Notre coursier s'en occupe !`);
                }
                else if (actionId.startsWith("market_")) {
                    const products = await prisma.product.findMany({ where: { category: "MARKET" } });
                    if(products.length > 0) {
                        const productRows = products.map(p => ({ id: `prod_${p.id}`, title: p.name.substring(0,24), description: `${p.price} FCFA` }));
                        await sendWhatsAppList(senderPhone, `🛒 Articles disponibles :`, productRows);
                    } else await sendWhatsAppMessage(senderPhone, "Ce rayon est vide pour le moment !");
                }
                else if (actionId === "flow_BUS") {
                    await prisma.user.update({ where: { id: user.id }, data: { botState: "BUS_STEP_1_DEST" } });
                    await sendWhatsAppMessage(senderPhone, `🚌 *Billetterie Bus*\n\n📍 Dans quelle ville souhaitez-vous aller ?`);
                }
                else if (actionId === "flow_FOOD") {
                    await prisma.user.update({ where: { id: user.id }, data: { botState: "FOOD_AWAITING_GPS" } });
                    await sendWhatsAppMessage(senderPhone, `📍 Pour trouver les restaurants autour de vous, veuillez envoyer votre *Position Actuelle* (📎 -> Localisation).`);
                }
                else if (actionId.startsWith("sel_resto_")) {
                    const restoId = actionId.replace("sel_resto_", "");
                    const products = await prisma.product.findMany({ where: { businessId: restoId } });
                    if(products.length > 0) {
                        const productRows = products.map(p => ({ id: `prod_${p.id}`, title: p.name.substring(0,24), description: `${p.price} FCFA` }));
                        await sendWhatsAppList(senderPhone, `🍽️ Voici le menu :`, productRows);
                    } else await sendWhatsAppMessage(senderPhone, "Ce restaurant n'a pas de menu.");
                }
                else if (actionId.startsWith("prod_")) {
                    const productId = actionId.replace("prod_", ""); 
                    const product = await prisma.product.findUnique({ where: { id: productId } });
                    if (product) {
                        let cart = await prisma.order.findFirst({ where: { userId: user.id, status: "DRAFT" } });
                        if (!cart) cart = await prisma.order.create({ data: { userId: user.id, businessId: product.businessId, status: "DRAFT", totalAmount: 0 } });
                        await prisma.orderItem.create({ data: { orderId: cart.id, productId: product.id, quantity: 1, price: product.price } });
                        const newTotal = cart.totalAmount + product.price;
                        await prisma.order.update({ where: { id: cart.id }, data: { totalAmount: newTotal } });
                        await sendWhatsAppButtons(senderPhone, `✅ *${product.name}* ajouté !\n💰 Total: *${newTotal} FCFA*`,[ { id: `sel_resto_${product.businessId}`, title: "➕ Ajouter article" }, { id: "cart_checkout", title: "💳 Valider Panier" } ]);
                    }
                }
                else if (actionId === "cart_checkout") {
                    const cart = await prisma.order.findFirst({ where: { userId: user.id, status: "DRAFT" }, include: { items: { include: { product: true } } } });
                    if (cart && cart.items.length > 0) {
                        await prisma.order.update({ where: { id: cart.id }, data: { status: "PENDING" } });
                        await sendWhatsAppMessage(senderPhone, `📝 *RÉCAPITULATIF :*\n💰 *TOTAL : ${cart.totalAmount} FCFA*\n\n📍 Envoyez votre *Position GPS* 📎 pour valider.`);
                    }
                }
            }
        }

        // ========================================================================
        // 📍 GESTION DU GPS
        // ========================================================================
        if (message.type === 'location') {
            const lat = message.location.latitude;
            const lng = message.location.longitude;
            await prisma.user.update({ where: { id: user.id }, data: { latitude: lat, longitude: lng } });

            if (user.botState === "FOOD_AWAITING_GPS") {
                const restos = await prisma.business.findMany({ where: { type: "FOOD" } });
                const restosWithDistance = restos.map(r => ({ ...r, distance: getDistanceFromLatLonInKm(lat, lng, r.latitude, r.longitude) })).sort((a, b) => a.distance - b.distance).slice(0, 5);
                if (restosWithDistance.length > 0) {
                    const listRows = restosWithDistance.map(r => ({ id: `sel_resto_${r.id}`, title: r.name.substring(0,24), description: `À ${r.distance.toFixed(1)} km` }));
                    await prisma.user.update({ where: { id: user.id }, data: { botState: "IDLE" } });
                    await sendWhatsAppList(senderPhone, `📍 *Restaurants proches :*`, listRows);
                } else await sendWhatsAppMessage(senderPhone, "Aucun restaurant dans votre zone.");
            }
            else if (user.botState === "TAXI_AWAITING_GPS") {
                const dest = user.tempData.destination;
                const typeTrans = user.tempData.type;
                const price = config?.taxi_pricing || 2000;
                let biz = await prisma.business.findFirst({ where: { type: "TRANSPORT" } });
                await prisma.order.create({ data: { userId: user.id, businessId: biz?.id, status: "PENDING", totalAmount: price, serviceName: `${typeTrans} vers ${dest}`, latitude: lat, longitude: lng } });
                await prisma.user.update({ where: { id: user.id }, data: { botState: "IDLE", tempData: {} } });
                await sendWhatsAppMessage(senderPhone, `✅ *Course Confirmée !*\n\n🚕 Recherche d'un ${typeTrans}... (Tapez "payé" pour valider)`);
            }
            else if (user.botState === "MARKET_AWAITING_GPS") {
                const pendingOrder = await prisma.order.findFirst({ where: { userId: user.id, status: "PENDING" }, orderBy: { createdAt: 'desc' } });
                if (pendingOrder) {
                    await prisma.order.update({ where: { id: pendingOrder.id }, data: { latitude: lat, longitude: lng } });
                    await prisma.user.update({ where: { id: user.id }, data: { botState: "IDLE" } });
                    await sendWhatsAppMessage(senderPhone, `✅ *Mission Validée !*\nUn coursier SIRA va faire vos achats.`);
                }
            }
            // 4. VALIDATION PANIER CLASSIQUE (CORRIGÉ)
            else {
                const pendingOrder = await prisma.order.findFirst({ where: { userId: user.id, status: "PENDING" }, orderBy: { createdAt: 'desc' } });
                if (pendingOrder) {
                    await prisma.order.update({ where: { id: pendingOrder.id }, data: { latitude: lat, longitude: lng } });
                    await sendWhatsAppMessage(senderPhone, `✅ Panier et GPS validés !\n\n💳 *PAIEMENT REQUIS*\nPour valider définitivement, veuillez régler *${pendingOrder.totalAmount} FCFA*.\n👉 Lien : https://pay.sira.com/simule/${pendingOrder.id.substring(0,6)}\n\n*(TEST DEV: Tapez "payé")*`);
                } else {
                    // LE CORRECTIF EST ICI : Le bot ne restera plus jamais muet !
                    await sendWhatsAppMessage(senderPhone, `📍 Position GPS bien reçue !\nMais je ne trouve aucune commande en attente de validation. Tapez "Menu" pour commencer une nouvelle commande.`);
                }
            }
        }
    } catch(e) { console.error("❌ Erreur Webhook:", e); }
});

// On ajoute '0.0.0.0' pour que Railway puisse se connecter au port !
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Serveur SIRA MONDIAL sur port ${PORT}`));