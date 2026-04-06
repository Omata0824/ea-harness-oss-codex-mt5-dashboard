// EA Harness base template
#property strict

input double InpLots = 0.10;
input int InpStopLossPoints = 300;
input int InpTakeProfitPoints = 600;
input int InpMagicNumber = 20260406;

int OnInit()
{
   return(INIT_SUCCEEDED);
}

void OnTick()
{
   // Strategy-specific logic is generated into the project source file.
}
