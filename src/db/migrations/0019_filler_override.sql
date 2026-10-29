-- The owner can move a message to small talk or back onto the map; automatic screening keeps that choice.
ALTER TABLE "messages" ADD COLUMN "filler_override" boolean;
