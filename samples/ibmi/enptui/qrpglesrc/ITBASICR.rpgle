**free
ctl-opt dftactgrp(*no) actgrp(*caller) option(*srcstmt:*nodebugio);

dcl-f ITBASICD workstn;

SINGLE = 1;
SCTL4 = 2;
MCTL1 = 1;
MCTL2 = 0;
MCTL3 = 0;
MCTL4 = 2;
RESULT = 'Initial state: Alpha and Red selected; unavailable choices disabled.';

dou *in03;
    exfmt MAIN;

    if *in05;
        RESULT = 'Refresh push button returned CF05.';
        *in05 = *off;
    else;
        RESULT = 'single=' + %trim(%char(SINGLE))
               + ' checks=' + %trim(%char(MCTL1)) + ','
               + %trim(%char(MCTL2)) + ',' + %trim(%char(MCTL3));
    endif;
enddo;

*inlr = *on;
return;
