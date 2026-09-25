-- Auto Post: add the `jobs` table (queue that replaced Redis/BullMQ).
-- Only needed if you imported hostinger-schema.sql BEFORE 2026-09-25 and cannot wait for
-- the next build (`npm run db:deploy` adds it automatically).
-- phpMyAdmin > select u774510961_db_autopost > Import this file.

SET NAMES utf8mb4;

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
