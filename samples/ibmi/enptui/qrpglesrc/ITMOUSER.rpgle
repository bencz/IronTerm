**free
ctl-opt dftactgrp(*no) actgrp(*caller) option(*srcstmt:*nodebugio);

dcl-f ITMOUSED workstn;

EVENTTXT = 'No event yet';

dou *in03;
    exfmt MAIN;

    if *in05;
        EVENTTXT = 'CF05 left press/release';
    elseif *in06;
        EVENTTXT = 'CF06 right press';
    elseif *in08;
        EVENTTXT = 'CF08 left double-click';
    else;
        EVENTTXT = 'Keyboard Enter';
    endif;

    OUTROW = CROW;
    OUTCOL = CCOL;
    OUTOROW = OROW;
    OUTOCOL = OCOL;
    *in05 = *off;
    *in06 = *off;
    *in08 = *off;
enddo;

*inlr = *on;
return;
