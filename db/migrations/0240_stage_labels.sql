-- The short stage list: "Bad default" is just "Default" and "Lost deal" is "Lost / dead" now that the retired stages
-- (workable default, killed, dead, declined, not interested) fold into them in the app. Keys and history are untouched.
update stages set label = 'Default' where key = 'default_bad';
update stages set label = 'Lost / dead' where key = 'lost';
