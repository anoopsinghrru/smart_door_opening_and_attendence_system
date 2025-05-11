#include <Keypad.h>
#include <LiquidCrystal_I2C.h>
#include <Servo.h>
#include <MFRC522.h>
#include <SPI.h>

// Keypad setup
const byte ROWS = 4;
const byte COLS = 4;
char keys[ROWS][COLS] = {
  {'1','2','3','A'},
  {'4','5','6','B'},
  {'7','8','9','C'},
  {'*','0','#','D'}
};
byte rowPins[ROWS] = {9, 8, 7, 6};
byte colPins[COLS] = {5, 4, 3, 2};
Keypad keypad = Keypad(makeKeymap(keys), rowPins, colPins, ROWS, COLS);

// LCD setup
LiquidCrystal_I2C lcd(0x27, 16, 2);

// Servo setup
Servo servo;
const int servoPin = 10;

// RFID setup
#define SS_PIN 14  // A0
#define RST_PIN 15 // A1
MFRC522 mfrc522(SS_PIN, RST_PIN);

// User data storage
struct User {
  String tagID;
  String password;
};
User users[10]; // Max 10 users (adjust as needed)
int userCount = 0;

// Variables
String enteredPassword = "";
bool waitingForRFID = false;
String lastTagID = "";
bool isLastEntry = false; // Tracks if the last verification was an entry

void setup() {
  Serial.begin(9600);
  SPI.begin();
  mfrc522.PCD_Init();
  servo.attach(servoPin);
  servo.write(135); // Initialize to closed position
  lcd.init();
  lcd.backlight();
  lcd.print("Enter password:");
}

void loop() {
  // Handle serial input for user data
  if (Serial.available()) {
    String command = Serial.readStringUntil('\n');
    command.trim();
    if (command.startsWith("USERS:")) {
      userCount = 0;
      String userData = command.substring(6);
      while (userData.length() > 0 && userCount < 10) {
        int tagEnd = userData.indexOf(',');
        if (tagEnd == -1) break;
        String tagID = userData.substring(0, tagEnd);
        userData = userData.substring(tagEnd + 1);
        int passEnd = userData.indexOf(';');
        if (passEnd == -1) passEnd = userData.length();
        String password = userData.substring(0, passEnd);
        users[userCount].tagID = tagID;
        users[userCount].password = password;
        userCount++;
        if (passEnd < userData.length()) {
          userData = userData.substring(passEnd + 1);
        } else {
          userData = "";
        }
      }
    }
  }

  // Handle keypad input
  char key = keypad.getKey();
  if (key) {
    if (key >= '0' && key <= '9') {
      enteredPassword += key;
      lcd.setCursor(enteredPassword.length() - 1, 1);
      lcd.print('*');
    } else if (key == '#') {
      // Check if entered password matches any user's password
      bool validPassword = false;
      for (int i = 0; i < userCount; i++) {
        if (enteredPassword == users[i].password) {
          validPassword = true;
          break;
        }
      }
      if (validPassword) {
        lcd.clear();
        lcd.print("Scan RFID");
        waitingForRFID = true;
      } else {
        lcd.clear();
        lcd.print("Invalid Password");
        delay(2000);
        lcd.clear();
        lcd.print("Enter password:");
        enteredPassword = "";
      }
    }
  }

  // Handle RFID scan
  if (waitingForRFID && mfrc522.PICC_IsNewCardPresent() && mfrc522.PICC_ReadCardSerial()) {
    String tagID = "";
    for (byte i = 0; i < mfrc522.uid.size; i++) {
      tagID += String(mfrc522.uid.uidByte[i] < 0x10 ? "0" : "");
      tagID += String(mfrc522.uid.uidByte[i], HEX);
    }
    tagID.toUpperCase();
    bool authorized = false;
    for (int i = 0; i < userCount; i++) {
      if (tagID == users[i].tagID && enteredPassword == users[i].password) {
        authorized = true;
        break;
      }
    }
    if (authorized) {
      bool isEntry = !(lastTagID == tagID && isLastEntry); // Entry if not the same tagID or not last entry
      lcd.clear();
      if (isEntry) {
        lcd.print("Enter the class");
      } else {
        lcd.print("Exit from class");
      }
      servo.write(0); // Open the gate
      Serial.println("AUTH:" + tagID);
      delay(5000); // Keep gate open for 5 seconds
      servo.write(135); // Close the gate
      lastTagID = tagID;
      isLastEntry = isEntry; // Update state
    } else {
      lcd.clear();
      lcd.print("Unauthorized");
      delay(2000);
    }
    mfrc522.PICC_HaltA();
    lcd.clear();
    lcd.print("Enter password:");
    waitingForRFID = false;
    enteredPassword = "";
  }
}