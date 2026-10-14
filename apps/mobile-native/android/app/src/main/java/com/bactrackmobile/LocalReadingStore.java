package com.bactrackmobile;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;

import org.json.JSONObject;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.UUID;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

final class LocalReadingStore extends SQLiteOpenHelper {
    private static final String DATABASE_NAME = "local_readings.db";
    private static final String KEY_ALIAS = "bactrack.local-readings.v1";
    private static final int DATABASE_VERSION = 2;
    private static final int GCM_TAG_BITS = 128;

    LocalReadingStore(Context context) {
        super(context, DATABASE_NAME, null, DATABASE_VERSION);
    }

    @Override
    public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE readings (id TEXT PRIMARY KEY NOT NULL, encrypted_payload BLOB NOT NULL)");
        createSyncTables(db);
    }

    @Override
    public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        if (oldVersion < 2) createSyncTables(db);
    }

    private void createSyncTables(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE IF NOT EXISTS synced_readings (id TEXT PRIMARY KEY NOT NULL)");
        db.execSQL("CREATE TABLE IF NOT EXISTS secure_settings (key TEXT PRIMARY KEY NOT NULL, encrypted_value BLOB NOT NULL)");
    }

    synchronized JSONObject add(float bacPercent, long measuredAt, String serial, JSONObject location) throws Exception {
        String id = UUID.randomUUID().toString();
        JSONObject reading = new JSONObject();
        reading.put("id", id);
        reading.put("bacPercent", bacPercent);
        reading.put("measuredAt", measuredAt);
        if (serial != null && !serial.isEmpty()) reading.put("serial", serial);
        if (location != null) {
            reading.put("latitude", location.getDouble("latitude"));
            reading.put("longitude", location.getDouble("longitude"));
            reading.put("accuracy", location.getDouble("accuracy"));
            reading.put("locationCapturedAt", location.getDouble("capturedAt"));
        }

        ContentValues values = new ContentValues();
        values.put("id", id);
        values.put("encrypted_payload", encrypt(reading.toString().getBytes(StandardCharsets.UTF_8)));
        getWritableDatabase().insertOrThrow("readings", null, values);
        return reading;
    }

    synchronized List<JSONObject> getAll() throws Exception {
        List<JSONObject> readings = new ArrayList<>();
        try (Cursor cursor = getReadableDatabase().query("readings", new String[]{"encrypted_payload"}, null, null, null, null, null)) {
            while (cursor.moveToNext()) {
                byte[] plaintext = decrypt(cursor.getBlob(0));
                readings.add(new JSONObject(new String(plaintext, StandardCharsets.UTF_8)));
            }
        }
        readings.sort(Comparator.comparingLong((JSONObject item) -> item.optLong("measuredAt")).reversed());
        return readings;
    }

    synchronized List<JSONObject> getUnsynced() throws Exception {
        List<JSONObject> readings = new ArrayList<>();
        String sql = "SELECT encrypted_payload FROM readings WHERE id NOT IN (SELECT id FROM synced_readings)";
        try (Cursor cursor = getReadableDatabase().rawQuery(sql, null)) {
            while (cursor.moveToNext()) {
                JSONObject reading = new JSONObject(new String(decrypt(cursor.getBlob(0)), StandardCharsets.UTF_8));
                if (!reading.optBoolean("cloud", false)) readings.add(reading);
            }
        }
        return readings;
    }

    synchronized void markSynced(List<String> ids) {
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            for (String id : ids) {
                ContentValues values = new ContentValues();
                values.put("id", id);
                db.insertWithOnConflict("synced_readings", null, values, SQLiteDatabase.CONFLICT_IGNORE);
            }
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
    }

    synchronized boolean isSynced(String id) {
        try (Cursor cursor = getReadableDatabase().query("synced_readings", new String[]{"id"},
                "id = ?", new String[]{id}, null, null, null)) {
            return cursor.moveToFirst();
        }
    }

    synchronized void addCloudReading(String id, double bacPercent, long measuredAt, String serial) throws Exception {
        JSONObject reading = new JSONObject();
        reading.put("id", id);
        reading.put("bacPercent", bacPercent);
        reading.put("measuredAt", measuredAt);
        reading.put("cloud", true);
        if (serial != null && !serial.isEmpty()) reading.put("serial", serial);
        ContentValues values = new ContentValues();
        values.put("id", id);
        values.put("encrypted_payload", encrypt(reading.toString().getBytes(StandardCharsets.UTF_8)));
        getWritableDatabase().insertWithOnConflict("readings", null, values, SQLiteDatabase.CONFLICT_IGNORE);
        markSynced(java.util.Collections.singletonList(id));
    }

    synchronized void setSecureValue(String key, String value) throws Exception {
        ContentValues values = new ContentValues();
        values.put("key", key);
        values.put("encrypted_value", encrypt(value.getBytes(StandardCharsets.UTF_8)));
        getWritableDatabase().insertWithOnConflict("secure_settings", null, values, SQLiteDatabase.CONFLICT_REPLACE);
    }

    synchronized String getSecureValue(String key) throws Exception {
        try (Cursor cursor = getReadableDatabase().query("secure_settings", new String[]{"encrypted_value"},
                "key = ?", new String[]{key}, null, null, null)) {
            if (!cursor.moveToFirst()) return null;
            return new String(decrypt(cursor.getBlob(0)), StandardCharsets.UTF_8);
        }
    }

    synchronized void clear() {
        getWritableDatabase().delete("readings", null, null);
        getWritableDatabase().delete("synced_readings", null, null);
    }

    private byte[] encrypt(byte[] plaintext) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey());
        byte[] iv = cipher.getIV();
        byte[] ciphertext = cipher.doFinal(plaintext);
        return ByteBuffer.allocate(1 + iv.length + ciphertext.length).put((byte) iv.length).put(iv).put(ciphertext).array();
    }

    private byte[] decrypt(byte[] payload) throws Exception {
        ByteBuffer buffer = ByteBuffer.wrap(payload);
        int ivLength = Byte.toUnsignedInt(buffer.get());
        if (ivLength == 0 || ivLength > buffer.remaining()) throw new IllegalStateException("Invalid encrypted reading");
        byte[] iv = new byte[ivLength];
        buffer.get(iv);
        byte[] ciphertext = new byte[buffer.remaining()];
        buffer.get(ciphertext);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), new GCMParameterSpec(GCM_TAG_BITS, iv));
        return cipher.doFinal(ciphertext);
    }

    private SecretKey getOrCreateKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
        keyStore.load(null);
        if (keyStore.containsAlias(KEY_ALIAS)) {
            return ((KeyStore.SecretKeyEntry) keyStore.getEntry(KEY_ALIAS, null)).getSecretKey();
        }
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build());
        return generator.generateKey();
    }
}
