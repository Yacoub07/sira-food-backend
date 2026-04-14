const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log("⏳ Création d'un restaurant de test...");

  // 1. Créer un restaurant
  const newRestaurant = await prisma.restaurant.create({
    data: {
      name: "Sira Burger Bamako",
      phone: "+22370000000", // Remplace par un numéro test
      address: "ACI 2000, Bamako",
      isOpen: true,
    },
  });

  console.log("✅ Restaurant créé :", newRestaurant);

  // 2. Créer un utilisateur (Client WhatsApp)
  const newUser = await prisma.user.create({
    data: {
      phone: "+22360000000",
      name: "Oumar",
    },
  });

  console.log("✅ Utilisateur créé :", newUser);
}

main()
  .catch((e) => {
    console.error("❌ Erreur :", e);
  })
  .finally(async () => {
    // Fermer la connexion à la BDD
    await prisma.$disconnect();
  });