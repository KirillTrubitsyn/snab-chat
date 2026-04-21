-- Fix: rename stored legacy name "Админ 2" to real name "Лунев Андрей"
-- in all tables that store admin_name.

UPDATE conversations
SET admin_name = 'Лунев Андрей'
WHERE admin_name = 'Админ 2';

UPDATE audit_log
SET admin_name = 'Лунев Андрей'
WHERE admin_name = 'Админ 2';

UPDATE infographics
SET admin_name = 'Лунев Андрей'
WHERE admin_name = 'Админ 2';
