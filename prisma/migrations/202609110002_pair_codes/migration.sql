-- 短码配对（E2 §6）：家人网页生成 6 位短码，相框端兑换一次性设备令牌。
CREATE TABLE `pair_codes` (
    `id` VARCHAR(191) NOT NULL,
    `family_id` VARCHAR(191) NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `created_by` VARCHAR(191) NOT NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `used_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `pair_codes_family_id_idx`(`family_id`),
    INDEX `pair_codes_code_idx`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `pair_codes` ADD CONSTRAINT `pair_codes_family_id_fkey` FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
