ALTER TABLE `posts` ADD COLUMN `cloud_cleaned_at` DATETIME(3) NULL;
ALTER TABLE `posts` ADD COLUMN `photo_count` INTEGER NOT NULL DEFAULT 0;

CREATE TABLE `frame_deliveries` (
    `id` VARCHAR(191) NOT NULL,
    `device_id` VARCHAR(191) NOT NULL,
    `post_id` VARCHAR(191) NOT NULL,
    `complete_at` DATETIME(3) NULL,
    `last_attempt_at` DATETIME(3) NULL,
    `failure_count` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `frame_deliveries_device_id_post_id_key`(`device_id`, `post_id`),
    INDEX `frame_deliveries_post_id_complete_at_idx`(`post_id`, `complete_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `frame_deliveries` ADD CONSTRAINT `frame_deliveries_device_id_fkey` FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `frame_deliveries` ADD CONSTRAINT `frame_deliveries_post_id_fkey` FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
