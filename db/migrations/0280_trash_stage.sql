-- Stage labels for the short list. "Dead deal" is now "Trash" (killed, declined, not interested and lost fold into it
-- in the app), and bad default is back to its plain name. Keys and history are untouched.
update stages set label = 'Bad default' where key = 'default_bad';
update stages set label = 'Lost deal' where key = 'lost';
update stages set label = 'Trash' where key = 'dead';
