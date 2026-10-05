-- Auto Post: database schema for MariaDB (Hostinger)
-- Generated from prisma/schema.prisma with:
--   npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script
--
-- Import: hPanel > Databases > phpMyAdmin > select database u774510961_db_autopost > Import this file.
-- Only for an EMPTY database. Later schema changes are applied by `npm run db:deploy` during the build.

SET NAMES utf8mb4;

-- CreateTable
CREATE TABLE `users` (
    `id` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NOT NULL,
    `passwordHash` VARCHAR(191) NULL,
    `name` VARCHAR(191) NOT NULL,
    `avatar` TEXT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `emailVerified` BOOLEAN NOT NULL DEFAULT false,
    `role` ENUM('ADMIN', 'USER') NOT NULL DEFAULT 'USER',
    `tokenVersion` INTEGER NOT NULL DEFAULT 0,
    `plan` ENUM('FREE', 'PRO', 'BUSINESS', 'ENTERPRISE') NOT NULL DEFAULT 'FREE',
    `planExpiresAt` DATETIME(3) NULL,
    `facebookUserId` VARCHAR(191) NULL,
    `facebookToken` TEXT NULL,
    `facebookTokenExp` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `lastLoginAt` DATETIME(3) NULL,

    UNIQUE INDEX `users_email_key`(`email`),
    UNIQUE INDEX `users_facebookUserId_key`(`facebookUserId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `api_keys` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `key` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `lastUsed` DATETIME(3) NULL,
    `expiresAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `api_keys_key_key`(`key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `settings` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `key` VARCHAR(191) NOT NULL,
    `value` TEXT NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `settings_userId_key_key`(`userId`, `key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `facebook_pages` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `pageId` VARCHAR(191) NOT NULL,
    `pageName` VARCHAR(191) NOT NULL,
    `pageAccessToken` TEXT NOT NULL,
    `pageCategory` VARCHAR(191) NULL,
    `pageAvatar` TEXT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `tokenAppId` VARCHAR(191) NULL,
    `tokenStatus` ENUM('UNCHECKED', 'VALID', 'OTHER_APP', 'EXPIRED', 'REVOKED', 'MISSING_PERMISSIONS', 'ERROR') NOT NULL DEFAULT 'UNCHECKED',
    `tokenExpiresAt` DATETIME(3) NULL,
    `missingScopes` JSON NULL,
    `grantedScopes` JSON NULL,
    `tokenCheckedAt` DATETIME(3) NULL,
    `tokenError` TEXT NULL,
    `defaultDomainId` VARCHAR(191) NULL,
    `autoReply` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `facebook_pages_userId_pageId_key`(`userId`, `pageId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `content_templates` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `description` VARCHAR(191) NULL,
    `promptTemplate` TEXT NOT NULL,
    `imagePrompt` TEXT NULL,
    `hashtags` JSON NULL,
    `category` VARCHAR(191) NULL,
    `variables` JSON NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `posts` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `pageId` VARCHAR(191) NOT NULL,
    `templateId` VARCHAR(191) NULL,
    `domainId` VARCHAR(191) NULL,
    `formatId` VARCHAR(191) NULL,
    `topic` VARCHAR(500) NULL,
    `tone` VARCHAR(191) NULL,
    `language` VARCHAR(191) NOT NULL DEFAULT 'vi',
    `extraNotes` TEXT NULL,
    `mode` ENUM('PREVIEW', 'PUBLISH_NOW') NOT NULL DEFAULT 'PREVIEW',
    `caption` TEXT NULL,
    `message` TEXT NULL,
    `imagePath` VARCHAR(191) NULL,
    `imageUrl` TEXT NULL,
    `imagePrompt` TEXT NULL,
    `videoPath` VARCHAR(191) NULL,
    `videoUrl` TEXT NULL,
    `videoMime` VARCHAR(191) NULL,
    `videoMeta` JSON NULL,
    `videoKind` ENUM('FEED', 'REEL') NULL,
    `hashtags` JSON NULL,
    `callToAction` VARCHAR(191) NULL,
    `aiPrompt` TEXT NULL,
    `aiResponse` TEXT NULL,
    `fbPostId` VARCHAR(191) NULL,
    `fbPhotoId` VARCHAR(191) NULL,
    `fbPermalink` TEXT NULL,
    `status` ENUM('DRAFT', 'GENERATING', 'READY', 'SCHEDULED', 'PUBLISHING', 'PUBLISHED', 'FAILED') NOT NULL DEFAULT 'DRAFT',
    `errorMessage` TEXT NULL,
    `errorStep` VARCHAR(191) NULL,
    `errorCode` VARCHAR(191) NULL,
    `publishedAt` DATETIME(3) NULL,
    `scheduledAt` DATETIME(3) NULL,
    `scheduleId` VARCHAR(191) NULL,
    `scheduleQueued` BOOLEAN NOT NULL DEFAULT false,
    `approvedAt` DATETIME(3) NULL,
    `inputData` JSON NULL,
    `reelDraft` JSON NULL,
    `autoReplyOff` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `posts_userId_status_idx`(`userId`, `status`),
    INDEX `posts_scheduledAt_idx`(`scheduledAt`),
    INDEX `posts_scheduleId_scheduleQueued_idx`(`scheduleId`, `scheduleQueued`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `post_logs` (
    `id` VARCHAR(191) NOT NULL,
    `postId` VARCHAR(191) NOT NULL,
    `action` VARCHAR(191) NOT NULL,
    `details` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `post_logs_postId_createdAt_idx`(`postId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `post_steps` (
    `id` VARCHAR(191) NOT NULL,
    `postId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `status` ENUM('RUNNING', 'SUCCESS', 'FAILED', 'SKIPPED') NOT NULL,
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `finishedAt` DATETIME(3) NULL,
    `durationMs` INTEGER NULL,
    `requestSummary` JSON NULL,
    `responseSummary` JSON NULL,
    `error` TEXT NULL,

    INDEX `post_steps_postId_startedAt_idx`(`postId`, `startedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `post_schedules` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `pageId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `frequency` ENUM('ONCE', 'DAILY', 'WEEKLY', 'MONTHLY', 'CUSTOM_CRON', 'SLOTS') NOT NULL,
    `cronExpr` VARCHAR(191) NULL,
    `timezone` VARCHAR(191) NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
    `startDate` DATETIME(3) NOT NULL,
    `endDate` DATETIME(3) NULL,
    `templateId` VARCHAR(191) NULL,
    `domainId` VARCHAR(191) NULL,
    `formatId` VARCHAR(191) NULL,
    `inputData` JSON NULL,
    `autoGenImage` BOOLEAN NOT NULL DEFAULT true,
    `weekdays` JSON NULL,
    `slots` JSON NULL,
    `bufferSize` INTEGER NOT NULL DEFAULT 3,
    `lastRunAt` DATETIME(3) NULL,
    `nextRunAt` DATETIME(3) NULL,
    `totalRuns` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `schedule_pages` (
    `scheduleId` VARCHAR(191) NOT NULL,
    `pageId` VARCHAR(191) NOT NULL,

    PRIMARY KEY (`scheduleId`, `pageId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `schedule_ideas` (
    `id` VARCHAR(191) NOT NULL,
    `scheduleId` VARCHAR(191) NOT NULL,
    `text` VARCHAR(500) NOT NULL,
    `position` INTEGER NOT NULL,
    `status` ENUM('QUEUED', 'USED') NOT NULL DEFAULT 'QUEUED',
    `postId` VARCHAR(191) NULL,
    `usedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `schedule_ideas_scheduleId_status_position_idx`(`scheduleId`, `status`, `position`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `jobs` (
    `id` VARCHAR(191) NOT NULL,
    `type` VARCHAR(50) NOT NULL,
    `key` VARCHAR(100) NULL,
    `payload` JSON NOT NULL,
    `status` ENUM('PENDING', 'RUNNING', 'DONE', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `runAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `maxAttempts` INTEGER NOT NULL DEFAULT 3,
    `lockToken` VARCHAR(36) NULL,
    `lockedAt` DATETIME(3) NULL,
    `interrupted` BOOLEAN NOT NULL DEFAULT false,
    `lastError` TEXT NULL,
    `finishedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `jobs_key_key`(`key`),
    INDEX `jobs_status_runAt_idx`(`status`, `runAt`),
    INDEX `jobs_lockToken_idx`(`lockToken`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `post_targets` (
    `id` VARCHAR(191) NOT NULL,
    `postId` VARCHAR(191) NOT NULL,
    `pageId` VARCHAR(191) NOT NULL,
    `status` ENUM('PENDING', 'PUBLISHING', 'PUBLISHED', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `scheduledAt` DATETIME(3) NULL,
    `fbPostId` VARCHAR(191) NULL,
    `fbPhotoId` VARCHAR(191) NULL,
    `fbPermalink` TEXT NULL,
    `errorMessage` TEXT NULL,
    `errorCode` VARCHAR(191) NULL,
    `publishedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `reactionCount` INTEGER NULL,
    `commentCount` INTEGER NULL,
    `shareCount` INTEGER NULL,
    `unansweredCount` INTEGER NOT NULL DEFAULT 0,
    `statsSyncedAt` DATETIME(3) NULL,
    `commentsError` TEXT NULL,

    INDEX `post_targets_pageId_idx`(`pageId`),
    UNIQUE INDEX `post_targets_postId_pageId_key`(`postId`, `pageId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `post_comments` (
    `id` VARCHAR(191) NOT NULL,
    `targetId` VARCHAR(191) NOT NULL,
    `fbCommentId` VARCHAR(191) NOT NULL,
    `parentFbId` VARCHAR(191) NULL,
    `authorId` VARCHAR(191) NULL,
    `authorName` VARCHAR(200) NULL,
    `message` TEXT NOT NULL,
    `commentedAt` DATETIME(3) NOT NULL,
    `fromPage` BOOLEAN NOT NULL DEFAULT false,
    `pageReplied` BOOLEAN NOT NULL DEFAULT false,
    `handledAt` DATETIME(3) NULL,
    `draftReply` TEXT NULL,
    `draftCheckedAt` DATETIME(3) NULL,
    `syncedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `post_comments_fbCommentId_key`(`fbCommentId`),
    INDEX `post_comments_targetId_parentFbId_idx`(`targetId`, `parentFbId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `content_domains` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(80) NOT NULL,
    `description` VARCHAR(300) NULL,
    `audience` TEXT NULL,
    `voice` TEXT NULL,
    `rules` TEXT NULL,
    `defaultHashtags` JSON NULL,
    `imageStyle` VARCHAR(500) NULL,
    `reelInstructions` TEXT NULL,
    `replyInstructions` TEXT NULL,
    `language` VARCHAR(191) NOT NULL DEFAULT 'vi',
    `isArchived` BOOLEAN NOT NULL DEFAULT false,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `content_domains_userId_name_key`(`userId`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `content_formats` (
    `id` VARCHAR(191) NOT NULL,
    `domainId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(80) NOT NULL,
    `instructions` TEXT NOT NULL,
    `example` TEXT NULL,
    `length` ENUM('SHORT', 'MEDIUM', 'LONG') NOT NULL DEFAULT 'MEDIUM',
    `withImage` BOOLEAN NOT NULL DEFAULT true,
    `isDefault` BOOLEAN NOT NULL DEFAULT false,
    `legacyPrompt` BOOLEAN NOT NULL DEFAULT false,
    `isArchived` BOOLEAN NOT NULL DEFAULT false,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `content_formats_domainId_name_key`(`domainId`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `api_keys` ADD CONSTRAINT `api_keys_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `settings` ADD CONSTRAINT `settings_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `facebook_pages` ADD CONSTRAINT `facebook_pages_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `facebook_pages` ADD CONSTRAINT `facebook_pages_defaultDomainId_fkey` FOREIGN KEY (`defaultDomainId`) REFERENCES `content_domains`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `content_templates` ADD CONSTRAINT `content_templates_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `posts` ADD CONSTRAINT `posts_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `posts` ADD CONSTRAINT `posts_pageId_fkey` FOREIGN KEY (`pageId`) REFERENCES `facebook_pages`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `posts` ADD CONSTRAINT `posts_templateId_fkey` FOREIGN KEY (`templateId`) REFERENCES `content_templates`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `posts` ADD CONSTRAINT `posts_domainId_fkey` FOREIGN KEY (`domainId`) REFERENCES `content_domains`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `posts` ADD CONSTRAINT `posts_formatId_fkey` FOREIGN KEY (`formatId`) REFERENCES `content_formats`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `posts` ADD CONSTRAINT `posts_scheduleId_fkey` FOREIGN KEY (`scheduleId`) REFERENCES `post_schedules`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `post_logs` ADD CONSTRAINT `post_logs_postId_fkey` FOREIGN KEY (`postId`) REFERENCES `posts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `post_steps` ADD CONSTRAINT `post_steps_postId_fkey` FOREIGN KEY (`postId`) REFERENCES `posts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `post_schedules` ADD CONSTRAINT `post_schedules_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `post_schedules` ADD CONSTRAINT `post_schedules_pageId_fkey` FOREIGN KEY (`pageId`) REFERENCES `facebook_pages`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `post_schedules` ADD CONSTRAINT `post_schedules_domainId_fkey` FOREIGN KEY (`domainId`) REFERENCES `content_domains`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `post_schedules` ADD CONSTRAINT `post_schedules_formatId_fkey` FOREIGN KEY (`formatId`) REFERENCES `content_formats`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `schedule_pages` ADD CONSTRAINT `schedule_pages_scheduleId_fkey` FOREIGN KEY (`scheduleId`) REFERENCES `post_schedules`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `schedule_pages` ADD CONSTRAINT `schedule_pages_pageId_fkey` FOREIGN KEY (`pageId`) REFERENCES `facebook_pages`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `schedule_ideas` ADD CONSTRAINT `schedule_ideas_scheduleId_fkey` FOREIGN KEY (`scheduleId`) REFERENCES `post_schedules`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `post_targets` ADD CONSTRAINT `post_targets_postId_fkey` FOREIGN KEY (`postId`) REFERENCES `posts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `post_targets` ADD CONSTRAINT `post_targets_pageId_fkey` FOREIGN KEY (`pageId`) REFERENCES `facebook_pages`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `post_comments` ADD CONSTRAINT `post_comments_targetId_fkey` FOREIGN KEY (`targetId`) REFERENCES `post_targets`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `content_domains` ADD CONSTRAINT `content_domains_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `content_formats` ADD CONSTRAINT `content_formats_domainId_fkey` FOREIGN KEY (`domainId`) REFERENCES `content_domains`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

