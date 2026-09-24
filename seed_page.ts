import { PrismaClient } from '@prisma/client';
import { encrypt } from './src/lib/crypto';
const prisma = new PrismaClient();

// Usage: npx tsx -r dotenv/config seed_page.ts
// Reads SEED_FB_PAGE_ID / SEED_FB_PAGE_NAME / SEED_FB_PAGE_TOKEN from .env
async function main() {
  const pageId = process.env.SEED_FB_PAGE_ID;
  const pageName = process.env.SEED_FB_PAGE_NAME || 'My Page';
  const rawToken = process.env.SEED_FB_PAGE_TOKEN;

  if (!pageId || !rawToken) {
    throw new Error('Missing SEED_FB_PAGE_ID or SEED_FB_PAGE_TOKEN in .env');
  }

  const pageAccessToken = encrypt(rawToken);

  let user = await prisma.user.findFirst();
  if (!user) {
    user = await prisma.user.create({
      data: {
        email: 'admin@example.com',
        name: 'Admin',
        passwordHash: 'dummy',
        plan: 'ENTERPRISE'
      }
    });
  }

  await prisma.facebookPage.upsert({
    where: { userId_pageId: { userId: user.id, pageId } },
    create: {
      userId: user.id,
      pageId,
      pageName,
      pageAccessToken,
      pageCategory: 'Giáo dục',
      isActive: true
    },
    update: {
      pageName,
      pageAccessToken,
      pageCategory: 'Giáo dục',
      isActive: true
    }
  });
  console.log(`Successfully connected page: ${pageName}`);
}
main().catch(console.error).finally(() => prisma.$disconnect());
