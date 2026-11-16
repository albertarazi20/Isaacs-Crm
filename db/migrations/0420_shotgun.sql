-- Shotgun warning (plan §6.13): a file that goes to more lenders than the shop allows is a backdoor risk and makes
-- lenders grade the shop down. The limit is a setting; sending past it is possible, on purpose, and logged.
alter table shop_settings add column max_lenders_per_deal int not null default 6 check (max_lenders_per_deal between 1 and 30);
