#include <SPI.h>
#include <MFRC522.h>

// RFID setup
#define SS_PIN 14  // A0
#define RST_PIN 15 // A1
MFRC522 mfrc522(SS_PIN, RST_PIN);

void setup() {
  Serial.begin(9600);
  while (!Serial); // Wait for Serial to initialize
  SPI.begin(); // Initialize SPI bus
  mfrc522.PCD_Init(); // Initialize MFRC522
  Serial.println("MFRC522 RFID Reader Verification");
  Serial.println("Scan an RFID tag to display its UID...");
  // Verify MFRC522 firmware version
  byte v = mfrc522.PCD_ReadRegister(mfrc522.VersionReg);
  if (v == 0x00 || v == 0xFF) {
    Serial.println("WARNING: Communication failure, is the MFRC522 properly connected?");
  } else {
    Serial.print("MFRC522 Firmware Version: 0x");
    Serial.println(v, HEX);
  }
}

void loop() {
  // Check for a new card
  if (!mfrc522.PICC_IsNewCardPresent() || !mfrc522.PICC_ReadCardSerial()) {
    delay(50);
    return;
  }
  // Read and format the UID
  String tagID = "";
  for (byte i = 0; i < mfrc522.uid.size; i++) {
    tagID += String(mfrc522.uid.uidByte[i] < 0x10 ? "0" : "");
    tagID += String(mfrc522.uid.uidByte[i], HEX);
  }
  tagID.toUpperCase();
  Serial.print("Tag UID: ");
  Serial.println(tagID);
  mfrc522.PICC_HaltA(); // Halt the card
  Serial.println("Scan another RFID tag...");
  delay(1000); // Avoid multiple reads
}