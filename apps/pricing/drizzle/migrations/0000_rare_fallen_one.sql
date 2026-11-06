CREATE TABLE "quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ride_id" uuid,
	"rider_id" uuid NOT NULL,
	"pickup_lat" double precision NOT NULL,
	"pickup_lng" double precision NOT NULL,
	"dropoff_lat" double precision NOT NULL,
	"dropoff_lng" double precision NOT NULL,
	"pickup_cell" varchar(32) NOT NULL,
	"vehicle_type" varchar(32) DEFAULT 'SEDAN' NOT NULL,
	"base_fare_minor_units" integer NOT NULL,
	"distance_meters" integer NOT NULL,
	"duration_sec" integer NOT NULL,
	"surge_multiplier" double precision NOT NULL,
	"total_fare_minor_units" integer NOT NULL,
	"currency" varchar(8) DEFAULT 'INR' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "surge_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cell" varchar(32) NOT NULL,
	"demand" double precision NOT NULL,
	"supply" double precision NOT NULL,
	"multiplier" double precision NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "surge_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cell" varchar(32) NOT NULL,
	"multiplier" double precision NOT NULL,
	"actor" varchar(64) NOT NULL,
	"reason" varchar(255) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
