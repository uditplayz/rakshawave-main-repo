// sandeepmistry/arduino-LoRa API (v0.8), re-implemented register for register
// so the SX1278 model in the lab sees the same SPI traffic as the real chip.
#pragma once
#include "Arduino.h"
#include "SPI.h"

#define LORA_DEFAULT_SPI SPI
#define LORA_DEFAULT_SPI_FREQUENCY 8E6
#define LORA_DEFAULT_SS_PIN 10
#define LORA_DEFAULT_RESET_PIN 9
#define LORA_DEFAULT_DIO0_PIN 2
#define PA_OUTPUT_RFO_PIN 0
#define PA_OUTPUT_PA_BOOST_PIN 1

class LoRaClass : public Stream {
 public:
  LoRaClass();
  int begin(long frequency);
  void end();
  int beginPacket(int implicitHeader = false);
  int endPacket(bool async = false);
  int parsePacket(int size = 0);
  int packetRssi();
  float packetSnr();
  long packetFrequencyError();
  int rssi();
  size_t write(uint8_t byte) override;
  size_t write(const uint8_t* buffer, size_t size) override;
  using Print::write;
  int available() override;
  int read() override;
  int peek() override;
  void flush() override {}
  void receive(int size = 0);
  void idle();
  void sleep();
  void setTxPower(int level, int outputPin = PA_OUTPUT_PA_BOOST_PIN);
  void setFrequency(long frequency);
  void setSpreadingFactor(int sf);
  void setSignalBandwidth(long sbw);
  void setCodingRate4(int denominator);
  void setPreambleLength(long length);
  void setSyncWord(int sw);
  void enableCrc();
  void disableCrc();
  void enableInvertIQ();
  void disableInvertIQ();
  void setOCP(uint8_t mA);
  void setGain(uint8_t gain);
  uint8_t random();
  void setPins(int ss = LORA_DEFAULT_SS_PIN, int reset = LORA_DEFAULT_RESET_PIN, int dio0 = LORA_DEFAULT_DIO0_PIN);
  void setSPI(SPIClass& spi) { _spi = &spi; }
  void setSPIFrequency(uint32_t frequency) { _spiSettings = SPISettings(frequency, MSBFIRST, SPI_MODE0); }

 private:
  void explicitHeaderMode();
  void implicitHeaderMode();
  bool isTransmitting();
  int getSpreadingFactor();
  long getSignalBandwidth();
  void setLdoFlag();
  uint8_t readRegister(uint8_t address);
  void writeRegister(uint8_t address, uint8_t value);
  uint8_t singleTransfer(uint8_t address, uint8_t value);

  SPISettings _spiSettings;
  SPIClass* _spi;
  int _ss, _reset, _dio0;
  long _frequency;
  int _packetIndex;
  int _implicitHeaderMode;
};

extern LoRaClass LoRa;
