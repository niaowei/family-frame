-- 家庭邀请码：家人登录使用（PRD §14 POST /api/auth/login 输入 familyCode）
ALTER TABLE `families` ADD COLUMN `code` VARCHAR(191) NOT NULL;

-- CreateTable
CREATE UNIQUE INDEX `families_code_key` ON `families`(`code`);
