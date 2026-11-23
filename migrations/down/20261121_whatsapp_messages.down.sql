-- DOWN for 20261121_whatsapp_messages.sql
-- DATA LOSS: drops the whole WhatsApp message log (audit trail of inbound/outbound messages). Export first.
drop table if exists whatsapp_messages;
